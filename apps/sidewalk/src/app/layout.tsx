import type { Metadata, Viewport } from 'next';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import { TRPCProvider } from '@/trpc/provider';

export const metadata: Metadata = {
  title: 'Sidewalk Map',
  description:
    'Runners, joggers and walkers mapping the curbs, steps and roadworks of their city — so wheelchairs, strollers and delivery robots know where they can go.',
  applicationName: 'Sidewalk Map',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Sidewalk Map',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0f1115',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
