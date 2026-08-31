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

/**
 * Share-card image.
 *
 * Absolute, and built from the origin plus the Pages base path, because every
 * scraper resolves og:image independently of the page it was found on - a
 * relative URL silently yields no preview.
 *
 * 1200x630 is the size declared below and the size every platform lays out for.
 * JPEG rather than PNG: the artwork is a photographic render, so JPEG costs
 * 120KB where the equivalent PNG costs 548KB, and WhatsApp in particular skips
 * previews for images much beyond a few hundred kilobytes. Regenerate from the
 * master with `npm run og`.
 */
const socialImage = {
  url: new URL(`${basePath}/og.jpg`, siteUrl.origin).toString(),
  width: 1200,
  height: 630,
  type: 'image/jpeg',
  alt: 'Gridline — a glass Tic-Tac-Toe board on a dark surface',
};

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: 'Gridline — A Shared Thinking Space',
  description: 'A private real-time Tic-Tac-Toe duel with temporary identities and ephemeral room chat.',
  openGraph: {
    type: 'website',
    siteName: 'Gridline',
    url: siteUrl.toString(),
    title: 'Gridline — A Shared Thinking Space',
    description: 'Create a private room, meet your opponent, and leave no chat history behind.',
    images: [socialImage],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gridline — A Shared Thinking Space',
    description: 'Create a private room, meet your opponent, and leave no chat history behind.',
    images: [socialImage],
  },
  icons: { icon: `${basePath}/favicon.svg` },
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
