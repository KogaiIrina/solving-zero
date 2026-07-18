import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolvingZero plan comparison",
  description: "A local electricity-plan comparison based on the household's usage data.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
