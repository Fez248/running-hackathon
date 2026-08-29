import type { Metadata } from 'next';
import 'leaflet/dist/leaflet.css';
import './globals.css';
import { TRPCProvider } from '@/trpc/provider';

export const metadata: Metadata = {
  title: 'Sidewalk Map',
  description:
    'Crowdsourced map of curbs, steps, roadworks and passable crossings for wheelchair users, stroller users, couriers and delivery robots.',
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
