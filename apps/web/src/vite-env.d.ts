/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_CORPUS_MODULE_ADDRESS?: string;
  readonly VITE_CORPUS_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
