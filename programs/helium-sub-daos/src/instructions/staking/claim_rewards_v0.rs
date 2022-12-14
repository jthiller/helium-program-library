use crate::{current_epoch, error::ErrorCode, state::*, EPOCH_LENGTH, TESTING};
use anchor_lang::prelude::*;
use anchor_spl::{
  associated_token::AssociatedToken,
  token::{Mint, Token, TokenAccount},
};
use circuit_breaker::{
  cpi::{accounts::TransferV0, transfer_v0},
  CircuitBreaker, TransferArgsV0,
};
use voter_stake_registry::state::{Registrar, Voter};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ClaimRewardsArgsV0 {
  pub deposit_entry_idx: u8,
  pub epoch: u64,
}

#[derive(Accounts)]
#[instruction(args: ClaimRewardsArgsV0)]
pub struct ClaimRewardsV0<'info> {
  #[account(
    seeds = [registrar.key().as_ref(), b"voter".as_ref(), voter_authority.key().as_ref()],
    seeds::program = vsr_program.key(),
    bump,
    has_one = voter_authority,
    has_one = registrar,
  )]
  pub vsr_voter: AccountLoader<'info, Voter>,
  #[account(mut)]
  pub voter_authority: Signer<'info>,
  #[account(
    seeds = [registrar.load()?.realm.as_ref(), b"registrar".as_ref(), dao.hnt_mint.as_ref()],
    seeds::program = vsr_program.key(),
    bump,
  )]
  pub registrar: AccountLoader<'info, Registrar>,
  pub dao: Box<Account<'info, DaoV0>>,

  #[account(
    mut,
    has_one = staker_pool,
    has_one = dnt_mint,
    has_one = dao,
  )]
  pub sub_dao: Account<'info, SubDaoV0>,
  #[account(
    mut,
    seeds = ["stake_position".as_bytes(), voter_authority.key().as_ref(), &[args.deposit_entry_idx]],
    bump,
  )]
  pub stake_position: Account<'info, StakePositionV0>,

  pub dnt_mint: Box<Account<'info, Mint>>,

  #[account(
    seeds = ["sub_dao_epoch_info".as_bytes(), sub_dao.key().as_ref(), &args.epoch.to_le_bytes()],
    bump,
  )]
  pub sub_dao_epoch_info: Box<Account<'info, SubDaoEpochInfoV0>>,
  #[account(mut)]
  pub staker_pool: Box<Account<'info, TokenAccount>>,
  #[account(
    init_if_needed,
    payer = voter_authority,
    associated_token::mint = dnt_mint,
    associated_token::authority = voter_authority,
  )]
  pub staker_ata: Box<Account<'info, TokenAccount>>,

  /// CHECK: checked via cpi
  #[account(
    mut,
    seeds = ["account_windowed_breaker".as_bytes(), staker_pool.key().as_ref()],
    seeds::program = circuit_breaker_program.key(),
    bump
  )]
  pub staker_pool_circuit_breaker: AccountInfo<'info>,

  ///CHECK: constraints
  #[account(address = voter_stake_registry::ID)]
  pub vsr_program: AccountInfo<'info>,
  pub system_program: Program<'info, System>,
  pub circuit_breaker_program: Program<'info, CircuitBreaker>,
  pub associated_token_program: Program<'info, AssociatedToken>,
  pub token_program: Program<'info, Token>,
  pub clock: Sysvar<'info, Clock>,
  pub rent: Sysvar<'info, Rent>,
}

impl<'info> ClaimRewardsV0<'info> {
  fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferV0<'info>> {
    let cpi_accounts = TransferV0 {
      from: self.staker_pool.to_account_info(),
      to: self.staker_ata.to_account_info(),
      owner: self.sub_dao.to_account_info(),
      circuit_breaker: self.staker_pool_circuit_breaker.to_account_info(),
      token_program: self.token_program.to_account_info(),
      clock: self.clock.to_account_info(),
    };

    CpiContext::new(self.circuit_breaker_program.to_account_info(), cpi_accounts)
  }
}

pub fn handler(ctx: Context<ClaimRewardsV0>, args: ClaimRewardsArgsV0) -> Result<()> {
  // load the vehnt information
  let voter = ctx.accounts.vsr_voter.load()?;
  let registrar = &ctx.accounts.registrar.load()?;
  let d_entry = voter.deposits[args.deposit_entry_idx as usize];
  let voting_mint_config = &registrar.voting_mints[d_entry.voting_mint_config_idx as usize];
  let curr_ts = registrar.clock_unix_timestamp();
  let available_vehnt = d_entry.voting_power(voting_mint_config, curr_ts)?;

  let stake_position = &mut ctx.accounts.stake_position;
  // find the current vehnt value of this position
  // curr_position_vehnt = available_vehnt * hnt_amount / amount_deposited_native
  let curr_position_vehnt = available_vehnt
    .checked_mul(stake_position.hnt_amount)
    .unwrap()
    .checked_div(d_entry.amount_deposited_native)
    .unwrap();

  // check epoch that's being claimed is over
  let epoch = current_epoch(ctx.accounts.clock.unix_timestamp);
  if !TESTING && args.epoch >= epoch {
    return Err(error!(ErrorCode::EpochNotOver));
  }

  if !TESTING && args.epoch != stake_position.last_claimed_epoch + 1 {
    return Err(error!(ErrorCode::InvalidClaimEpoch));
  }

  let epoch_end_ts = if TESTING {
    curr_ts
  } else {
    i64::try_from(args.epoch)
      .unwrap()
      .checked_mul(EPOCH_LENGTH)
      .unwrap()
  };

  // calculate the vehnt value of this position at the time of the epoch
  let ts_diff = curr_ts
    .checked_sub(epoch_end_ts)
    .unwrap()
    .checked_sub(
      d_entry
        .lockup
        .seconds_since_expiry(curr_ts)
        .try_into()
        .unwrap(),
    )
    .unwrap();
  let staked_vehnt_at_epoch = curr_position_vehnt
    .checked_add(
      stake_position
        .fall_rate
        .checked_mul(ts_diff.try_into().unwrap())
        .unwrap(),
    )
    .unwrap();

  // calculate the position's share of that epoch's rewards
  // rewards = staking_rewards_issued * staked_vehnt_at_epoch / total_vehnt
  let rewards = staked_vehnt_at_epoch
    .checked_mul(ctx.accounts.sub_dao_epoch_info.staking_rewards_issued)
    .unwrap()
    .checked_div(ctx.accounts.sub_dao_epoch_info.total_vehnt)
    .unwrap();

  stake_position.last_claimed_epoch = epoch;

  transfer_v0(
    ctx.accounts.transfer_ctx().with_signer(&[&[
      b"sub_dao",
      ctx.accounts.sub_dao.dnt_mint.as_ref(),
      &[ctx.accounts.sub_dao.bump_seed],
    ]]),
    TransferArgsV0 { amount: rewards },
  )?;
  Ok(())
}