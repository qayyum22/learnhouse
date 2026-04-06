'use client'
import '../styles/globals.css'
import { SessionProvider } from '@components/Contexts/AuthContext'
import LHSessionProvider from '@components/Contexts/LHSessionContext'
import { getLEARNHOUSE_TOP_DOMAIN_VAL, getLEARNHOUSE_TELEMETRY_DISABLED_VAL } from '@services/config/config'

const isDevEnv = getLEARNHOUSE_TOP_DOMAIN_VAL() === 'localhost'
const isTelemetryDisabled = getLEARNHOUSE_TELEMETRY_DISABLED_VAL() === 'true'
import Script from 'next/script'
import '../lib/i18n'
import I18nProvider from '@components/Contexts/I18nContext'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      style={
        {
          '--font-default':
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
        } as React.CSSProperties
      }
    >
      <head>
        {/* Synchronous script — blocks parsing to guarantee window.__RUNTIME_CONFIG__ exists before any JS runs.
            Next.js <Script strategy="beforeInteractive"> is not truly blocking in all browsers (Safari). */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/runtime-config.js" />
        {/* Prevent white flash on embed routes: set html+body bg before body is painted.
            Reads the optional ?bgcolor param (hex-validated) or defaults to dark. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/embed-bg.js" />
      </head>
      <body>
        {
            isDevEnv ? '' : isTelemetryDisabled ? '' :
                            <Script
                                data-website-id="a1af6d7a-9286-4a1f-8385-ddad2a29fcbb"
                                src="/umami/script.js"
                            />
        }
        <SessionProvider refetchInterval={600000}>
          <LHSessionProvider>
            <I18nProvider>
              <main className="animate-fade-in">
                  {children}
                </main>
            </I18nProvider>
          </LHSessionProvider>
        </SessionProvider>
      </body>
    </html>
  )
}
