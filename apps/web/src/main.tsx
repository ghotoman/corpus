import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { NETWORK } from "./config";
import "./styles.css";

// The provider is always mounted (useWallet needs it); the wallet UI itself is
// gated by VITE_ENABLE_WALLET — see WALLET_ENABLED in config.ts.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AptosWalletAdapterProvider
      autoConnect={false}
      dappConfig={{ network: NETWORK }}
      onError={(error) => console.error("[wallet-adapter]", error)}
    >
      <App />
    </AptosWalletAdapterProvider>
  </React.StrictMode>,
);
