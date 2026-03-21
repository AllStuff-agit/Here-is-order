import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from '@/components/app-shell';
import { Inter } from "next/font/google";

export const metadata: Metadata = {
  title: "Here is order",
  description: "재고 갱신과 발주 관리 대시보드",
};

const inter = Inter({ subsets: ["latin"], variable: '--font-sans' });

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`antialiased ${inter.variable}`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
