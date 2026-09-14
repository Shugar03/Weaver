import type { Metadata } from "next";
import { Space_Grotesk, VT323 } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const tech = VT323({ weight: "400", subsets: ["latin"], variable: "--font-tech" });

export const metadata: Metadata = {
  title: "WEAVER — Open Compute",
  description: "A more open internet for intelligence. Decentralized compute for the next generation of AI.",
  icons: "/weaver-logo.png",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${tech.variable}`}>
      <body className="bg-void font-display text-white antialiased">{children}</body>
    </html>
  );
}
