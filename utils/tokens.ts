// TODO: replace this whole file with something more modern. This is all copied
//       from sollet.

import * as BufferLayout from "buffer-layout";
import { BN } from "@project-serum/anchor";
import {
  TOKEN_PROGRAM_ID,
  AccountInfo as TokenAccount,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { isValidPublicKey } from "../utils/utils"
import {
  getTokenAccountsByOwnerWithWrappedSol
} from '@blockworks-foundation/mango-client'

export async function getMultipleTokenAccounts(
  connection: Connection,
  wallet: PublicKey,
  mints: Array<PublicKey>) {

  let tokenAccounts = Array<{ publicKey: PublicKey, account: TokenAccount }>()

  for (const mint of mints) {

    if (!isValidPublicKey(mint)) {
      console.log('Invalid public key: ', mint)
      continue
    }

    const filter = {
      mint
    }

    const resp = await connection.getTokenAccountsByOwner(wallet, filter, 'recent')
      .then(res => res.value)
      .catch(err => {
        console.log('Failed to get token account: ', filter.mint.toString())
        console.log('Err: ', err)
        return null
      })

    if (resp) {
      const accounts = resp.map(({ pubkey, account: { data, executable, owner, lamports } }: any) => ({
        publicKey: pubkey,
        accountInfo: {
          data: data,
          executable,
          owner: new PublicKey(owner),
          lamports,
        },
      }))
        .map(({ publicKey, accountInfo }: any) => {
          return { publicKey, account: parseTokenAccountData(accountInfo.data) };
        });

      tokenAccounts = tokenAccounts.concat(accounts)
    }
  }

  return tokenAccounts
}

export async function getOwnedTokenAccounts(
  connection: Connection,
  publicKey: PublicKey
) {
  const tokens = await getTokenAccountsByOwnerWithWrappedSol(connection, publicKey);
  tokens.map(t => {
    return {
      publicKey: t.publicKey,
      account: {
        mint: t.mint,
        owner: t.owner,
        amount: t.amount
      }
    };
  })
  return tokens;
  // let filters = getOwnedAccountsFilters(publicKey);
  // // @ts-ignore
  // let resp = await connection.getProgramAccounts(
  //   TOKEN_PROGRAM_ID,
  //   {
  //     filters,
  //     encoding: 'base64'
  //   },
  // );

  // return resp
  //   .map(({ pubkey, account: { data, executable, owner, lamports } }: any) => ({
  //     publicKey: new PublicKey(pubkey),
  //     accountInfo: {
  //       data: data,
  //       executable,
  //       owner: new PublicKey(owner),
  //       lamports,
  //     },
  //   }))
  //   .map(({ publicKey, accountInfo }: any) => {
  //     return { publicKey, account: parseTokenAccountData(accountInfo.data) };
  //   });
}

const ACCOUNT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(32, "mint"),
  BufferLayout.blob(32, "owner"),
  BufferLayout.nu64("amount"),
  BufferLayout.blob(93),
]);

export function getBigNumber(num: any) {
  return num === undefined || num === null ? 0 : parseFloat(num.toString())
}

export function parseTokenAccountData(data: Buffer): TokenAccount {
  // @ts-ignore
  let { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  console.log('amount: ', amount)
  // @ts-ignore
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount: new BN(getBigNumber(amount)),
  };
}

function getOwnedAccountsFilters(publicKey: PublicKey) {
  return [
    {
      memcmp: {
        // @ts-ignore
        offset: ACCOUNT_LAYOUT.offsetOf("owner"),
        bytes: publicKey.toBase58(),
      },
    },
    {
      dataSize: ACCOUNT_LAYOUT.span,
    },
  ];
}
