import { useLocalStorageState } from './utils';
import { Account, AccountInfo, Connection, ConnectionConfig, PublicKey } from '@solana/web3.js';
import React, { useContext, useEffect, useMemo, useRef } from 'react';
import { setCache, useAsyncData } from './fetch-loop';
import tuple from 'immutable-tuple';
import { ConnectionContextValues, EndpointInfo } from './types';
import { tokenAuthFetchMiddleware } from "../utils/rpc";

export const ENDPOINTS: EndpointInfo[] = [
  {
    name: 'mainnet-beta',
    // endpoint: 'https://solape.genesysgo.net/',
    endpoint: "https://us-west-1.genesysgo.net/a99fd25a-d5de-4568-a04f-465771a94278",
    gpaEndpoint: "https://dry-ravine-67635.herokuapp.com/rpc",
    // endpoint: "https://mango.rpcpool.com",
    custom: true,
  },
  {
    name: 'localnet',
    endpoint: 'https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/',
    gpaEndpoint: '',
    custom: false
  },
];

const accountListenerCount = new Map();

const ConnectionContext: React.Context<null | ConnectionContextValues> = React.createContext<null | ConnectionContextValues>(
  null,
);

export const getGenesysGoToken = async () => {
  const URL = process.env.REACT_APP_CHART_API || 'https://dry-ravine-67635.herokuapp.com';

  const req = await fetch(`${URL}/login`);
  const { access_token }: { access_token: string } = await req.json();
  // console.log('access_token: ', access_token);
  return access_token;
};

export function ConnectionProvider({ children }) {
  const [endpoint, setEndpoint] = useLocalStorageState<string>(
    'connectionEndpts',
    ENDPOINTS[0].endpoint,
  );
  const [gpaEndpoint, setGpaEndpoint] = useLocalStorageState<string>(
    'gpaConnectionEndpts',
    ENDPOINTS[0].gpaEndpoint,
  );
  const [customEndpoints, setCustomEndpoints] = useLocalStorageState<
    EndpointInfo[]
  >('customConnectionEndpoints', []);
  const availableEndpoints = ENDPOINTS.concat(customEndpoints);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config: ConnectionConfig = {
    commitment: "recent",
    fetchMiddleware: tokenAuthFetchMiddleware({
      getToken: getGenesysGoToken,
    }),
  };

  const connection = useMemo(() => new Connection(endpoint, config), [config, endpoint]);
  const gpaConnection = useMemo(() => new Connection(gpaEndpoint, config), [config, gpaEndpoint]);
  const sendConnection = useMemo(() => new Connection(endpoint, config), [config, endpoint]);

  // The websocket library solana/web3.js uses closes its websocket connection when the subscription list
  // is empty after opening its first time, preventing subsequent subscriptions from receiving responses.
  // This is a hack to prevent the list from every getting empty
  useEffect(() => {
    const id = connection.onAccountChange(new Account().publicKey, () => { });
    return () => {
      connection.removeAccountChangeListener(id);
    };
  }, [connection]);

  useEffect(() => {
    const id = connection.onSlotChange(() => null);
    return () => {
      connection.removeSlotChangeListener(id);
    };
  }, [connection]);

  useEffect(() => {
    const id = sendConnection.onAccountChange(
      new Account().publicKey,
      () => { },
    );
    return () => {
      sendConnection.removeAccountChangeListener(id);
    };
  }, [sendConnection]);

  useEffect(() => {
    const id = sendConnection.onSlotChange(() => null);
    return () => {
      sendConnection.removeSlotChangeListener(id);
    };
  }, [sendConnection]);

  return (
    <ConnectionContext.Provider
      value={{
        endpoint,
        setEndpoint,
        connection,
        gpaConnection,
        sendConnection,
        availableEndpoints,
        setCustomEndpoints,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('Missing connection context');
  }
  return context.connection;
}

export function useGpaConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('Missing connection context');
  }
  return context.gpaConnection;
}

export function useSendConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('Missing connection context');
  }
  return context.sendConnection;
}

export function useConnectionConfig() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('Missing connection context');
  }
  return {
    endpoint: context.endpoint,
    endpointInfo: context.availableEndpoints.find(
      (info) => info.endpoint === context.endpoint,
    ),
    setEndpoint: context.setEndpoint,
    availableEndpoints: context.availableEndpoints,
    setCustomEndpoints: context.setCustomEndpoints,
  };
}

export function useAccountInfo(
  publicKey: PublicKey | undefined | null,
): [AccountInfo<Buffer> | null | undefined, boolean] {
  const connection = useConnection();
  const cacheKey = tuple(connection, publicKey?.toBase58());
  const [accountInfo, loaded] = useAsyncData<AccountInfo<Buffer> | null>(
    async () => (publicKey ? connection.getAccountInfo(publicKey) : null),
    cacheKey,
    { refreshInterval: 60_000 },
  );
  useEffect(() => {
    if (!publicKey) {
      return;
    }
    if (accountListenerCount.has(cacheKey)) {
      let currentItem = accountListenerCount.get(cacheKey);
      ++currentItem.count;
    } else {
      let previousInfo: AccountInfo<Buffer> | null = null;
      const subscriptionId = connection.onAccountChange(publicKey, (info: { data: any; lamports: any; }) => {
        if (
          !previousInfo ||
          !previousInfo.data.equals(info.data) ||
          previousInfo.lamports !== info.lamports
        ) {
          previousInfo = info;
          setCache(cacheKey, info);
        }
      });
      accountListenerCount.set(cacheKey, { count: 1, subscriptionId });
    }
    return () => {
      let currentItem = accountListenerCount.get(cacheKey);
      let nextCount = currentItem.count - 1;
      if (nextCount <= 0) {
        connection.removeAccountChangeListener(currentItem.subscriptionId);
        accountListenerCount.delete(cacheKey);
      } else {
        --currentItem.count;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);
  const previousInfoRef = useRef<AccountInfo<Buffer> | null | undefined>(null);
  if (
    !accountInfo ||
    !previousInfoRef.current ||
    !previousInfoRef.current.data.equals(accountInfo.data) ||
    previousInfoRef.current.lamports !== accountInfo.lamports
  ) {
    previousInfoRef.current = accountInfo;
  }
  return [previousInfoRef.current, loaded];
}

export function useAccountData(publicKey: any) {
  const [accountInfo] = useAccountInfo(publicKey);
  return accountInfo && accountInfo.data;
}
