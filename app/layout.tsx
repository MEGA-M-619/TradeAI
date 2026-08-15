import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradeAI",
  description: "AI-powered field assistant for electricians",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
