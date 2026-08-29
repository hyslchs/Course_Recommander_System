/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FJU_CLIENT_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
