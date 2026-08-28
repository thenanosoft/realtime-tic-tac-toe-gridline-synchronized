import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000');
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const socialImageUrl = new URL(`${basePath}/og.png`, siteUrl.origin).toString();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: 'Gridline — A Shared Thinking Space',
  description: 'A private real-time Tic-Tac-Toe duel with temporary identities and ephemeral room chat.',
  openGraph: {
    title: 'Gridline — A Shared Thinking Space',
    description: 'Create a private room, meet your opponent, and leave no chat history behind.',
    images: [{ url: socialImageUrl, width: 1200, height: 630, alt: 'Gridline private real-time Tic-Tac-Toe' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gridline — A Shared Thinking Space',
    description: 'Create a private room, meet your opponent, and leave no chat history behind.',
    images: [socialImageUrl],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
