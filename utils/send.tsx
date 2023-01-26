import { notify } from './notifications';
import { getDecimalCount, sleep } from './utils';
import { getSelectedTokenAccountForMint } from './markets';
import {
  Account,
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionSignature,
  Signer,
} from '@solana/web3.js';
import {
  Token,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  DexInstructions,
  Market,
  OpenOrders, parseInstructionErrorResponse,
  TokenInstructions,
} from '@project-serum/serum';
import { TOKEN_MINTS } from './tokensAndMarkets';
import { SelectedTokenAccounts, TokenAccount } from './types';
import { Order } from '@project-serum/serum/lib/market';
import { Buffer } from 'buffer';
import assert from 'assert';
import { any, array, boolean, literal, number, object, string, union } from 'superstruct';
// import { Wallet } from '@solana/wallet-adapter-base';
import { Wallet } from "@solana/wallet-adapter-react";

type SignTransactionType = <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>

export async function createTokenAccountTransaction({
  connection,
  wallet,
  mintPublicKey,
}: {
  connection: Connection;
  wallet: Wallet;
  mintPublicKey: PublicKey;
}): Promise<{
  transaction: Transaction;
  newAccountPubkey: PublicKey;
}> {
  const ata = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPublicKey,
    wallet.adapter.publicKey,
  );
  const transaction = new Transaction();
  transaction.add(
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintPublicKey,
      ata,
      wallet.adapter.publicKey,
      wallet.adapter.publicKey,
    ),
  );
  return {
    transaction,
    newAccountPubkey: ata,
  };
}

export async function settleFunds({
  market,
  openOrders,
  connection,
  wallet,
  signTransaction,
  baseCurrencyAccount,
  quoteCurrencyAccount,
  sendNotification = true,
  usdcRef = undefined,
  usdtRef = undefined,
}: {
  market: Market;
  openOrders: OpenOrders;
  connection: Connection;
  wallet: Wallet;
  signTransaction: SignTransactionType;
  baseCurrencyAccount: TokenAccount;
  quoteCurrencyAccount: TokenAccount;
  sendNotification?: boolean;
  usdcRef?: PublicKey;
  usdtRef?: PublicKey;
}): Promise<string | undefined> {
  if (
    !market ||
    !wallet ||
    !connection ||
    !openOrders ||
    (!baseCurrencyAccount && !quoteCurrencyAccount)
  ) {
    if (sendNotification) {
      notify({ message: 'Not connected' });
    }
    return;
  }

  let createAccountTransaction: Transaction | undefined;
  let baseCurrencyAccountPubkey = baseCurrencyAccount?.pubkey;
  let quoteCurrencyAccountPubkey = quoteCurrencyAccount?.pubkey;

  if (!baseCurrencyAccountPubkey) {
    const result = await createTokenAccountTransaction({
      connection,
      wallet,
      mintPublicKey: market.baseMintAddress,
    });
    baseCurrencyAccountPubkey = result?.newAccountPubkey;
    createAccountTransaction = result?.transaction;
  }

  if (!quoteCurrencyAccountPubkey) {
    const result = await createTokenAccountTransaction({
      connection,
      wallet,
      mintPublicKey: market.quoteMintAddress,
    });
    quoteCurrencyAccountPubkey = result?.newAccountPubkey;
    createAccountTransaction = result?.transaction;
  }

  let referrerQuoteWallet: PublicKey | null = null;
  if (market.supportsReferralFees) {
    const usdt = TOKEN_MINTS.find(({ name }) => name === 'USDT');
    const usdc = TOKEN_MINTS.find(({ name }) => name === 'USDC');
    if (usdtRef && usdt && market.quoteMintAddress.equals(usdt.address)) {
      referrerQuoteWallet = usdtRef;
    } else if (
      usdcRef &&
      usdc &&
      market.quoteMintAddress.equals(usdc.address)
    ) {
      referrerQuoteWallet = usdcRef;
    }
  }
  const {
    transaction: settleFundsTransaction,
    signers: settleFundsSigners,
  } = await market.makeSettleFundsTransaction(
    connection,
    openOrders,
    baseCurrencyAccountPubkey,
    quoteCurrencyAccountPubkey,
    referrerQuoteWallet,
  );

  let transaction = mergeTransactions([
    createAccountTransaction,
    settleFundsTransaction,
  ]);

  console.log('Send tx');

  return await sendTransaction({
    transaction,
    signers: settleFundsSigners,
    wallet,
    connection,
    signTransaction,
    sendingMessage: 'Settling funds...',
    sendNotification,
  });
}

export async function settleAllFunds({
  connection,
  wallet,
  tokenAccounts,
  signTransaction,
  markets,
  selectedTokenAccounts,
}: {
  connection: Connection;
  wallet: Wallet;
  signTransaction: SignTransactionType;
  tokenAccounts: TokenAccount[];
  markets: Market[];
  selectedTokenAccounts?: SelectedTokenAccounts;
}) {
  if (!markets || !wallet || !connection || !tokenAccounts) {
    return;
  }

  const programIds: PublicKey[] = [];
  markets
    .reduce((cumulative, m) => {
      // @ts-ignore
      cumulative.push(m._programId);
      return cumulative;
    }, [])
    .forEach((programId) => {
      if (!programIds.find((p) => p.equals(programId))) {
        programIds.push(programId);
      }
    });

  const getOpenOrdersAccountsForProgramId = async (programId) => {
    const openOrdersAccounts = await OpenOrders.findForOwner(
      connection,
      wallet.adapter.publicKey,
      programId,
    );
    return openOrdersAccounts.filter(
      (openOrders) =>
        openOrders.baseTokenFree.toNumber() ||
        openOrders.quoteTokenFree.toNumber(),
    );
  };

  const openOrdersAccountsForProgramIds = await Promise.all(
    programIds.map((programId) => getOpenOrdersAccountsForProgramId(programId)),
  );
  const openOrdersAccounts = openOrdersAccountsForProgramIds.reduce(
    (accounts, current) => accounts.concat(current),
    [],
  );

  const settleTransactions = (
    await Promise.all(
      openOrdersAccounts.map((openOrdersAccount) => {
        const market = markets.find((m) =>
          // @ts-ignore
          m._decoded?.ownAddress?.equals(openOrdersAccount.market),
        );
        if (
          openOrdersAccount.baseTokenFree.isZero() &&
          openOrdersAccount.quoteTokenFree.isZero()
        ) {
          // nothing to settle for this market.
          return null;
        }
        const baseMint = market?.baseMintAddress;
        const quoteMint = market?.quoteMintAddress;

        const selectedBaseTokenAccount = getSelectedTokenAccountForMint(
          tokenAccounts,
          baseMint,
          baseMint &&
          selectedTokenAccounts &&
          selectedTokenAccounts[baseMint.toBase58()],
        )?.pubkey;
        const selectedQuoteTokenAccount = getSelectedTokenAccountForMint(
          tokenAccounts,
          quoteMint,
          quoteMint &&
          selectedTokenAccounts &&
          selectedTokenAccounts[quoteMint.toBase58()],
        )?.pubkey;
        if (!selectedBaseTokenAccount || !selectedQuoteTokenAccount) {
          return null;
        }
        return (
          market &&
          market.makeSettleFundsTransaction(
            connection,
            openOrdersAccount,
            selectedBaseTokenAccount,
            selectedQuoteTokenAccount,
          )
        );
      }),
    )
  ).filter(
    (
      x,
    ): x is {
      signers: Account[];
      transaction: Transaction;
      payer: PublicKey;
    } => !!x,
  );
  if (!settleTransactions || settleTransactions.length === 0) return;

  const transactions = settleTransactions.slice(0, 4).map((t) => t.transaction);
  const signers: Array<Account> = [];
  settleTransactions
    .reduce((cumulative: Array<Account>, t) => cumulative.concat(t.signers), [])
    .forEach((signer) => {
      if (!signers.find((s) => s.publicKey.equals(signer.publicKey))) {
        signers.push(signer);
      }
    });

  const transaction = mergeTransactions(transactions);

  return await sendTransaction({
    transaction,
    signers,
    signTransaction,
    wallet,
    connection,
  });
}

export async function cancelOrder(params: {
  market: Market;
  connection: Connection;
  wallet: Wallet;
  signTransaction: SignTransactionType;
  order: Order;
}) {
  return cancelOrders({ ...params, orders: [params.order] });
}

export async function cancelOrders({
  market,
  wallet,
  signTransaction,
  connection,
  orders,
}: {
  market: Market;
  wallet: Wallet;
  signTransaction: SignTransactionType;
  connection: Connection;
  orders: Order[];
}) {
  const transaction = market.makeMatchOrdersTransaction(5);
  orders.forEach((order) => {
    transaction.add(
      market.makeCancelOrderInstruction(connection, wallet.adapter.publicKey, order),
    );
  });
  transaction.add(market.makeMatchOrdersTransaction(5));
  return await sendTransaction({
    transaction,
    wallet,
    signTransaction,
    connection,
    sendingMessage: 'Sending cancel...',
  });
}

export async function placeOrder({
  side,
  price,
  size,
  orderType,
  market,
  connection,
  wallet,
  signTransaction,
  baseCurrencyAccount,
  quoteCurrencyAccount,
  feeDiscountPubkey = undefined,
}: {
  side: 'buy' | 'sell';
  price: number;
  size: number;
  signTransaction: SignTransactionType;
  orderType: 'ioc' | 'postOnly' | 'limit';
  market: Market | undefined | null;
  connection: Connection;
  wallet: Wallet;
  baseCurrencyAccount: PublicKey | undefined;
  quoteCurrencyAccount: PublicKey | undefined;
  feeDiscountPubkey: PublicKey | undefined;
}) {
  let formattedMinOrderSize =
    market?.minOrderSize?.toFixed(getDecimalCount(market.minOrderSize)) ||
    market?.minOrderSize;
  let formattedTickSize =
    market?.tickSize?.toFixed(getDecimalCount(market.tickSize)) ||
    market?.tickSize;
  const isIncrement = (num, step) =>
    Math.abs((num / step) % 1) < 1e-5 ||
    Math.abs(((num / step) % 1) - 1) < 1e-5;
  if (isNaN(price)) {
    notify({ message: 'Invalid price', type: 'error' });
    return;
  }
  if (isNaN(size)) {
    notify({ message: 'Invalid size', type: 'error' });
    return;
  }
  if (!wallet || !wallet.adapter.publicKey) {
    notify({ message: 'Connect wallet', type: 'error' });
    return;
  }
  if (!market) {
    notify({ message: 'Invalid  market', type: 'error' });
    return;
  }
  if (!isIncrement(size, market.minOrderSize)) {
    notify({
      message: `Size must be an increment of ${formattedMinOrderSize}`,
      type: 'error',
    });
    return;
  }
  if (size < market.minOrderSize) {
    notify({ message: 'Size too small', type: 'error' });
    return;
  }
  if (!isIncrement(price, market.tickSize)) {
    notify({
      message: `Price must be an increment of ${formattedTickSize}`,
      type: 'error',
    });
    return;
  }
  if (price < market.tickSize) {
    notify({ message: 'Price under tick size', type: 'error' });
    return;
  }
  const owner = wallet.adapter.publicKey;
  const transaction = new Transaction();
  const signers: Account[] = [];

  if (!baseCurrencyAccount) {
    const {
      transaction: createAccountTransaction,
      newAccountPubkey,
    } = await createTokenAccountTransaction({
      connection,
      wallet,
      mintPublicKey: market.baseMintAddress,
    });
    transaction.add(createAccountTransaction);
    baseCurrencyAccount = newAccountPubkey;
  }
  if (!quoteCurrencyAccount) {
    const {
      transaction: createAccountTransaction,
      newAccountPubkey,
    } = await createTokenAccountTransaction({
      connection,
      wallet,
      mintPublicKey: market.quoteMintAddress,
    });
    transaction.add(createAccountTransaction);
    quoteCurrencyAccount = newAccountPubkey;
  }

  const payer = side === 'sell' ? baseCurrencyAccount : quoteCurrencyAccount;
  if (!payer) {
    notify({
      message: 'Need an SPL token account for cost currency',
      type: 'error',
    });
    return;
  }
  const params = {
    owner,
    payer,
    side,
    price,
    size,
    orderType,
    feeDiscountPubkey: feeDiscountPubkey || null,
  };
  console.log(params);

  const matchOrderstransaction = market.makeMatchOrdersTransaction(5);
  transaction.add(matchOrderstransaction);
  const startTime = getUnixTs();
  let {
    transaction: placeOrderTx,
    signers: placeOrderSigners,
  } = await market.makePlaceOrderTransaction(
    connection,
    params,
    120_000,
    120_000,
  );
  const endTime = getUnixTs();
  console.log(`Creating order transaction took ${endTime - startTime}`);
  transaction.add(placeOrderTx);
  transaction.add(market.makeMatchOrdersTransaction(5));
  signers.push(...placeOrderSigners);

  return await sendTransaction({
    transaction,
    wallet,
    signTransaction,
    connection,
    signers,
    sendingMessage: 'Sending order...',
  });
}

export async function listMarket({
  connection,
  wallet,
  baseMint,
  quoteMint,
  baseLotSize,
  quoteLotSize,
  dexProgramId,
  signAllTransactions
}: {
  connection: Connection;
  wallet: Wallet;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseLotSize: number;
  quoteLotSize: number;
  dexProgramId: PublicKey;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>;
}) {
  const market = new Account();
  const requestQueue = new Account();
  const eventQueue = new Account();
  const bids = new Account();
  const asks = new Account();
  const baseVault = new Account();
  const quoteVault = new Account();
  const feeRateBps = 0;
  const quoteDustThreshold = new BN(100);

  async function getVaultOwnerAndNonce() {
    const nonce = new BN(0);
    while (true) {
      try {
        const vaultOwner = await PublicKey.createProgramAddress(
          [market.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
          dexProgramId,
        );
        return [vaultOwner, nonce];
      } catch (e) {
        nonce.iaddn(1);
      }
    }
  }
  const [vaultOwner, vaultSignerNonce] = await getVaultOwnerAndNonce();

  const tx1 = new Transaction();
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: baseVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: quoteVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: baseVault.publicKey,
      mint: baseMint,
      owner: vaultOwner,
    }),
    TokenInstructions.initializeAccount({
      account: quoteVault.publicKey,
      mint: quoteMint,
      owner: vaultOwner,
    }),
  );

  const tx2 = new Transaction();
  tx2.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: market.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        Market.getLayout(dexProgramId).span,
      ),
      space: Market.getLayout(dexProgramId).span,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: requestQueue.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(5120 + 12),
      space: 5120 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: eventQueue.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(262144 + 12),
      space: 262144 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: bids.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
      space: 65536 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.adapter.publicKey,
      newAccountPubkey: asks.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
      space: 65536 + 12,
      programId: dexProgramId,
    }),
    DexInstructions.initializeMarket({
      market: market.publicKey,
      requestQueue: requestQueue.publicKey,
      eventQueue: eventQueue.publicKey,
      bids: bids.publicKey,
      asks: asks.publicKey,
      baseVault: baseVault.publicKey,
      quoteVault: quoteVault.publicKey,
      baseMint,
      quoteMint,
      baseLotSize: new BN(baseLotSize),
      quoteLotSize: new BN(quoteLotSize),
      feeRateBps,
      vaultSignerNonce,
      quoteDustThreshold,
      programId: dexProgramId,
      authority: undefined,
    }),
  );

  const signedTransactions = await signAllTransactions([tx1, tx2]);

  // const signedTransactions = await signTransactions({
  //   transactionsAndSigners: [
  //     { transaction: tx1, signers: [baseVault, quoteVault] },
  //     {
  //       transaction: tx2,
  //       signers: [market, requestQueue, eventQueue, bids, asks],
  //     },
  //   ],
  //   wallet,
  //   connection,
  // });
  for (let signedTransaction of signedTransactions) {
    await sendSignedTransaction({
      signedTransaction,
      connection,
    });
  }

  return market.publicKey;
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

const DEFAULT_TIMEOUT = 15000;

export async function sendTransaction({
  transaction,
  wallet,
  signers = [],
  connection,
  signTransaction,
  sendingMessage = 'Sending transaction...',
  sentMessage = 'Transaction sent',
  successMessage = 'Transaction confirmed',
  timeout = DEFAULT_TIMEOUT,
  sendNotification = true,
}: {
  transaction: Transaction;
  wallet: Wallet;
  signTransaction: SignTransactionType
  signers?: Array<Signer>;
  connection: Connection;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
  sendNotification?: boolean;
}) {
  let { blockhash } = await connection.getLatestBlockhash('finalized');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.adapter.publicKey;

  for (let signer of signers) {
    transaction.partialSign(signer);
  }

  const signedTransaction = await signTransaction(transaction);
  return await sendSignedTransaction({
    signedTransaction,
    connection,
    sendingMessage,
    sentMessage,
    successMessage,
    timeout,
    sendNotification,
  });
}

// export async function signTransaction({
//   transaction,
//   wallet,
//   signers = [],
//   connection,
// }: {
//   transaction: Transaction;
//   wallet: Wallet;
//   signers?: Array<Account>;
//   connection: Connection;
// }) {
//   transaction.recentBlockhash = (
//     await connection.getRecentBlockhash('max')
//   ).blockhash;
//   transaction.setSigners(wallet.adapter.publicKey, ...signers.map((s) => s.publicKey));
//   if (signers.length > 0) {
//     transaction.partialSign(...signers);
//   }
//   return await wallet.signTransaction(transaction);
// }

// export async function signTransactions({
//   transactionsAndSigners,
//   wallet,
//   connection,
// }: {
//   transactionsAndSigners: {
//     transaction: Transaction;
//     signers?: Array<Account>;
//   }[];
//   wallet: Wallet;
//   connection: Connection;
// }) {
//   const blockhash = (await connection.getRecentBlockhash('max')).blockhash;
//   transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
//     transaction.recentBlockhash = blockhash;
//     transaction.setSigners(
//       wallet.adapter.publicKey,
//       ...signers.map((s) => s.publicKey),
//     );
//     if (signers?.length > 0) {
//       transaction.partialSign(...signers);
//     }
//   });
//   return await wallet.signAllTransactions(
//     transactionsAndSigners.map(({ transaction }) => transaction),
//   );
// }

export async function sendSignedTransaction({
  signedTransaction,
  connection,
  sendingMessage = 'Sending transaction...',
  sentMessage = 'Transaction sent',
  successMessage = 'Transaction confirmed',
  timeout = DEFAULT_TIMEOUT,
  sendNotification = true,
}: {
  signedTransaction: Transaction;
  connection: Connection;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
  sendNotification?: boolean;
}): Promise<string> {
  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  if (sendNotification) {
    notify({ message: sendingMessage });
  }
  const txid: TransactionSignature = await connection.sendRawTransaction(
    rawTransaction,
    {
      skipPreflight: true,
    },
  );
  if (sendNotification) {
    notify({ message: sentMessage, type: 'success', txid });
  }

  console.log('Started awaiting confirmation for', txid);

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < timeout) {
      connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      });
      await sleep(300);
    }
  })();
  try {
    await awaitTransactionSignatureConfirmation(txid, timeout, connection);
  } catch (err) {
    if (err.timeout) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }
    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (
        await simulateTransaction(connection, signedTransaction, 'single')
      ).value;
    } catch (e) { }
    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
          const line = simulateResult.logs[i];
          if (line.startsWith('Program log: ')) {
            throw new Error(
              'Transaction failed: ' + line.slice('Program log: '.length),
            );
          }
        }
      }
      let parsedError;
      if (
        typeof simulateResult.err == 'object' &&
        'InstructionError' in simulateResult.err
      ) {
        const parsedErrorInfo = parseInstructionErrorResponse(
          signedTransaction,
          // @ts-ignore
          simulateResult.err,
        );
        parsedError = parsedErrorInfo.error;
      } else {
        parsedError = JSON.stringify(simulateResult.err);
      }
      throw new Error(parsedError);
    }
    throw new Error('Transaction failed');
  } finally {
    done = true;
  }
  if (sendNotification) {
    notify({ message: successMessage, type: 'success', txid });
  }

  console.log('Latency', txid, getUnixTs() - startTime);
  return txid;
}

async function awaitTransactionSignatureConfirmation(
  txid: TransactionSignature,
  timeout: number,
  connection: Connection,
) {
  let done = false;
  const result = await new Promise((resolve, reject) => {
    (async () => {
      setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        console.log('Timed out for txid', txid);
        reject({ timeout: true });
      }, timeout);
      try {
        connection.onSignature(
          txid,
          (result) => {
            console.log('WS confirmed', txid, result);
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(result);
            }
          },
          'recent',
        );
        console.log('Set up WS connection', txid);
      } catch (e) {
        done = true;
        console.log('WS error in setup', txid, e);
      }
      while (!done) {
        // eslint-disable-next-line no-loop-func
        (async () => {
          try {
            const signatureStatuses = await connection.getSignatureStatuses([
              txid,
            ]);
            const result = signatureStatuses && signatureStatuses.value[0];
            if (!done) {
              if (!result) {
                console.log('REST null result for', txid, result);
              } else if (result.err) {
                console.log('REST error for', txid, result);
                done = true;
                reject(result.err);
              } else if (!result.confirmations) {
                console.log('REST no confirmations for', txid, result);
              } else {
                console.log('REST confirmation for', txid, result);
                done = true;
                resolve(result);
              }
            }
          } catch (e) {
            if (!done) {
              console.log('REST connection error: txid', txid, e);
            }
          }
        })();
        await sleep(300);
      }
    })();
  });
  done = true;
  return result;
}

function mergeTransactions(transactions: (Transaction | undefined)[]) {
  const transaction = new Transaction();
  transactions
    .filter((t): t is Transaction => t !== undefined)
    .forEach((t) => {
      transaction.add(t);
    });
  return transaction;
}

function jsonRpcResult(resultDescription: any) {
  const jsonRpcVersion = literal('2.0');
  return union([
    object({
      jsonrpc: jsonRpcVersion,
      id: string(),
      error: any(),
    }),
    object({
      jsonrpc: jsonRpcVersion,
      id: string(),
      error: null, // "null?"
      result: resultDescription,
    }),
  ]);
}

function jsonRpcResultAndContext(resultDescription: any) {
  return jsonRpcResult({
    context: object({
      slot: number(),
    }),
    value: resultDescription,
  });
}

const AccountInfoResult = object({
  executable: boolean(),
  owner: string(),
  lamports: number(),
  data: any(),
  rentEpoch: number(),
});

export const GetMultipleAccountsAndContextRpcResult = jsonRpcResultAndContext(
  array(union([AccountInfoResult])),
);

export async function getMultipleSolanaAccounts(
  connection: Connection,
  publicKeys: PublicKey[],
): Promise<
  RpcResponseAndContext<{ [key: string]: AccountInfo<Buffer> | null }>
> {
  const args = [publicKeys.map((k) => k.toBase58()), { commitment: 'recent' }];
  // @ts-ignore
  const unsafeRes = await connection._rpcRequest('getMultipleAccounts', args);
  assert(GetMultipleAccountsAndContextRpcResult, unsafeRes);

  const res = unsafeRes;
  if (res.error) {
    throw new Error(
      'failed to get info about accounts ' +
      publicKeys.map((k) => k.toBase58()).join(', ') +
      ': ' +
      res.error.message,
    );
  }
  assert(typeof res.result !== 'undefined');
  const accounts: Array<{
    executable: any;
    owner: PublicKey;
    lamports: any;
    data: Buffer;
  } | null> = [];
  for (const account of res.result.value) {
    let value: {
      executable: any;
      owner: PublicKey;
      lamports: any;
      data: Buffer;
    } | null = null;
    if (res.result.value) {
      const { executable, owner, lamports, data } = account;
      assert(data[1] === 'base64');
      value = {
        executable,
        owner: new PublicKey(owner),
        lamports,
        data: Buffer.from(data[0], 'base64'),
      };
    }
    accounts.push(value);
  }
  return {
    context: {
      slot: res.result.context.slot,
    },
    value: Object.fromEntries(
      accounts.map((account, i) => [publicKeys[i].toBase58(), account]),
    ),
  };
}

/** Copy of Connection.simulateTransaction that takes a commitment parameter. */
async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching,
  );

  const signData = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');
  const config: any = { encoding: 'base64', commitment };
  const args = [encodedTransaction, config];

  // @ts-ignore
  const res = await connection._rpcRequest('simulateTransaction', args);
  if (res.error) {
    throw new Error('failed to simulate transaction: ' + res.error.message);
  }
  return res.result;
}
