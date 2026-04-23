/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["imapflow", "nodemailer", "mailparser"],
  },
};

module.exports = nextConfig;
