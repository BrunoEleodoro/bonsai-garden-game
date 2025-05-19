import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider, getDefaultConfig } from "connectkit";
import { ReactNode } from "react";
import { chains } from "@lens-chain/sdk/viem";

const config = createConfig(
  getDefaultConfig({
    chains: [chains.mainnet],
    transports: {
      [chains.mainnet.id]: http(`https://rpc.mainnet.lens.dev`),
    },

    // Required API Keys
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_ID || "",

    // Required App Info
    appName: "Lens Mainnet Demo",
  })
);

const queryClient = new QueryClient();

export const Web3Provider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={config}>
    <QueryClientProvider client={queryClient}>
      <ConnectKitProvider>{children}</ConnectKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
);
