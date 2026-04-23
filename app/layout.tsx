import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mail Credential Checker",
  description: "Verify email/password combos over SMTP and IMAP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
