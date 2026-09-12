/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Swarm ID runs inside a hidden cross-origin iframe and communicates by
  // postMessage, so nothing here may block framing of swarm-id.snaha.net.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default nextConfig;
