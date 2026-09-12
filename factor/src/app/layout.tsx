import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Factor — sell an invoice in minutes",
  description:
    "Invoice financing on Avalanche Fuji, with an expiring Arkiv bid book, encrypted documents on Swarm and ENSv2 business subnames.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <a className="brand" href="/">
            Factor
          </a>
          <nav>
            <a href="/">Market</a>
            <a href="/issue">Issue an invoice</a>
          </nav>
          <span className="chains">
            Fuji 43113 · Arkiv 7738577 · Sepolia 11155111
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
