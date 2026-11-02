import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";
import { themeInit } from "@/lib/themeInit";

const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Switchyards Studio",
  description: "Club build-outs and design work: briefs, drawings, review rounds and what's next.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full bg-(--c-b-ffffff)">
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
