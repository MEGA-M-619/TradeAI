import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui/ToastProvider";

export const metadata: Metadata = {
  title: "TradeAI",
  description: "AI-powered field assistant for electricians",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Prevents iOS auto-zoom on input focus, which fights the app's own
  // layout when a technician taps a form field in the field.
  maximumScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
