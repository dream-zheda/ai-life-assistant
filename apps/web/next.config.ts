import type { NextConfig } from "next";

const config: NextConfig = {
  // workspace 内部的包直接引用 TS 源码（main 指向 src/index.ts），必须让 Next 参与编译
  transpilePackages: [
    "@life/shared",
    "@life/domain",
    "@life/channels",
    "@life/llm",
    "@life/planning",
    "@life/db",
  ],
  // Prisma 的生成产物含原生引擎，不能被打包进 bundle
  serverExternalPackages: ["@prisma/client", "prisma"],
  experimental: {
    // 服务端动作上传体积（个人档案是纯文本，够用）
    serverActions: { bodySizeLimit: "1mb" },
  },
  /**
   * workspace 内的包用 ESM 写法显式写了 `.js` 后缀（指向 `.ts` 源文件）。
   * 这是 TypeScript 的合法写法，但 webpack 默认不认，需要告诉它把 `.js`
   * 依次尝试解析成 `.ts` / `.tsx` / `.js`。
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default config;
