/**
 * 发版签名公钥（Ed25519）：后台自动更新只安装用对应私钥签过名的安装包（scripts/sign-package.mjs）。
 * 私钥不在仓库里；换密钥时同时更新这里和发版流水线的 Secret，已安装的旧版本要重新运行一次安装命令。
 */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAw8mLozRPuUZBw7f5zA7eeooWh8LiLvVjNHXH7pGXof0=
-----END PUBLIC KEY-----`;
