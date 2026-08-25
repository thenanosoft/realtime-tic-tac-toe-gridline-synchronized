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

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'Gridline — Real-time Tic-Tac-Toe',
  description: 'A polished two-player Tic-Tac-Toe game synchronized over WebSockets.',
  openGraph: {
    title: 'Gridline — Real-time Tic-Tac-Toe',
    description: 'Create a private room and challenge a friend in a beautifully synchronized duel.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Gridline real-time Tic-Tac-Toe' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gridline — Real-time Tic-Tac-Toe',
    description: 'Create a private room and challenge a friend in a beautifully synchronized duel.',
    images: ['/og.png'],
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
