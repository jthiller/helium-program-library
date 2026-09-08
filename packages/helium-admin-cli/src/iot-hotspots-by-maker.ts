import * as anchor from "@coral-xyz/anchor";
import {
  HNT_MINT,
  IOT_MINT,
  chunks,
  getAssetBatch,
  getAssetsByGroup,
} from "@helium/spl-utils";
import {
  dataOnlyConfigKey,
  init as initHem,
  keyToAssetKey,
  rewardableEntityConfigKey,
} from "@helium/helium-entity-manager-sdk";
import { daoKey, subDaoKey } from "@helium/helium-sub-daos-sdk";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import yargs from "yargs/yargs";

const DATA_ONLY_MAKER_NAME = "Data Only";
const UNKNOWN_MAKER_NAME = "Unknown";

/**
 * There is no `maker` field on KeyToAssetV0 or IotHotspotInfoV0. The only
 * on-chain link between a hotspot and the maker that manufactured it is the
 * Metaplex collection of the hotspot's compressed NFT: `issue_entity_v0` mints
 * every hotspot into `MakerV0.collection`, which is the PDA
 * ["collection", maker]. That collection never changes for a maker (the merkle
 * tree does, via update_maker_tree_v0), so collection -> maker is the stable
 * mapping to key off of.
 *
 * Reading it therefore needs a DAS-capable RPC (Helius etc.), because the cNFT
 * lives in a merkle tree rather than in a regular account.
 */
export async function run(args: any = process.argv) {
  const yarg = yargs(args).options({
    wallet: {
      alias: "k",
      describe: "Anchor wallet keypair",
      default: `${os.homedir()}/.config/solana/id.json`,
    },
    url: {
      alias: "u",
      default: "http://127.0.0.1:8899",
      describe: "The solana url. Must support the DAS (read) API",
    },
    hotspots: {
      alias: "f",
      type: "string",
      describe:
        "File of hotspot addresses (base58 entity keys) to attribute, one per line or a JSON array. Omit to count every hotspot in every maker collection instead.",
    },
    out: {
      alias: "o",
      type: "string",
      describe: "Write a per-hotspot address,maker CSV here",
    },
  });
  const argv = await yarg.argv;
  process.env.ANCHOR_WALLET = argv.wallet;
  process.env.ANCHOR_PROVIDER_URL = argv.url;
  anchor.setProvider(anchor.AnchorProvider.local(argv.url));
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const hemProgram = await initHem(provider);

  const dao = daoKey(HNT_MINT)[0];
  const iotConfig = rewardableEntityConfigKey(subDaoKey(IOT_MINT)[0], "IOT")[0];

  // Only count makers that were approved to issue onto the IOT rewardable
  // entity config. MakerApprovalV0 is [rewardable_entity_config, maker, bump].
  const iotApprovals = await hemProgram.account.makerApprovalV0.all(
    iotConfig.toBuffer(),
  );
  const iotMakers = new Set(
    iotApprovals.map((a) => a.account.maker.toBase58()),
  );

  const makers = await hemProgram.account.makerV0.all();
  const collectionToMaker = new Map<string, string>();
  for (const maker of makers) {
    if (!maker.account.dao.equals(dao)) continue;
    if (!iotMakers.has(maker.publicKey.toBase58())) continue;
    collectionToMaker.set(
      maker.account.collection.toBase58(),
      maker.account.name,
    );
  }

  // Data only hotspots are issued by issue_data_only_entity_v0 into the
  // DataOnlyConfigV0 collection, so they have no maker at all.
  const dataOnly = await hemProgram.account.dataOnlyConfigV0.fetchNullable(
    dataOnlyConfigKey(dao)[0],
  );
  if (dataOnly) {
    collectionToMaker.set(dataOnly.collection.toBase58(), DATA_ONLY_MAKER_NAME);
  }

  console.error(`Resolved ${collectionToMaker.size} IOT hotspot collections`);

  const counts = new Map<string, number>();
  const bump = (name: string) => counts.set(name, (counts.get(name) || 0) + 1);

  if (argv.hotspots) {
    const rows = await attributeHotspots({
      hemProgram,
      dao,
      url: argv.url,
      collectionToMaker,
      addresses: readAddresses(argv.hotspots),
    });
    for (const [, maker] of rows) bump(maker);
    if (argv.out) {
      fs.writeFileSync(
        argv.out,
        [
          "address,maker",
          ...rows.map(([a, m]) => `${a},${JSON.stringify(m)}`),
        ].join("\n"),
      );
      console.error(`Wrote ${rows.length} rows to ${argv.out}`);
    }
  } else {
    // No input set: page every collection to get total issued per maker.
    for (const [collection, maker] of collectionToMaker) {
      let cursor: string | undefined;
      let total = 0;
      do {
        const page = await getAssetsByGroup(argv.url, {
          groupValue: collection,
          limit: 1000,
          cursor,
        });
        total += page.items.length;
        cursor = page.items.length === 0 ? undefined : page.cursor;
      } while (cursor);
      counts.set(maker, (counts.get(maker) || 0) + total);
      console.error(`${maker}: ${total}`);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    JSON.stringify(
      {
        total: sorted.reduce((acc, [, n]) => acc + n, 0),
        byMaker: Object.fromEntries(sorted),
      },
      null,
      2,
    ),
  );
}

function readAddresses(file: string): string[] {
  const raw = fs.readFileSync(file, "utf-8").trim();
  if (raw.startsWith("[")) {
    return JSON.parse(raw);
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * address (base58 entity key)
 *   -> key_to_asset PDA ["key_to_asset", dao, sha256(entity_key)]
 *   -> KeyToAssetV0.asset (the cNFT id)
 *   -> DAS getAssetBatch -> grouping "collection"
 *   -> MakerV0.collection -> maker name
 */
async function attributeHotspots({
  hemProgram,
  dao,
  url,
  collectionToMaker,
  addresses,
}: {
  hemProgram: Awaited<ReturnType<typeof initHem>>;
  dao: PublicKey;
  url: string;
  collectionToMaker: Map<string, string>;
  addresses: string[];
}): Promise<[string, string][]> {
  const rows: [string, string][] = [];

  for (const batch of chunks(addresses, 1000)) {
    const ktaKeys = batch.map((address) => keyToAssetKey(dao, address)[0]);
    const ktas = await hemProgram.account.keyToAssetV0.fetchMultiple(ktaKeys);

    const assetToAddress = new Map<string, string>();
    ktas.forEach((kta, i) => {
      if (kta) {
        assetToAddress.set(kta.asset.toBase58(), batch[i]);
      } else {
        // No key_to_asset means the address was never onboarded to Solana.
        rows.push([batch[i], UNKNOWN_MAKER_NAME]);
      }
    });

    const assets =
      (await getAssetBatch(
        url,
        [...assetToAddress.keys()].map((a) => new PublicKey(a)),
      )) || [];

    const seen = new Set<string>();
    for (const asset of assets) {
      if (!asset) continue;
      const address = assetToAddress.get(asset.id.toBase58());
      if (!address) continue;
      seen.add(address);
      const collection = asset.grouping?.find(
        (g) => g.group_key === "collection",
      )?.group_value;
      rows.push([
        address,
        (collection && collectionToMaker.get(collection.toBase58())) ||
          UNKNOWN_MAKER_NAME,
      ]);
    }
    for (const address of assetToAddress.values()) {
      if (!seen.has(address)) rows.push([address, UNKNOWN_MAKER_NAME]);
    }

    console.error(`Attributed ${rows.length}/${addresses.length}`);
  }

  return rows;
}
