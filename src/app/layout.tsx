import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/constants";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "@/components/providers";
import "./globals.css";

const satoshi = localFont({
    src: [
        { path: "./fonts/Satoshi-400.woff2", weight: "400" },
        { path: "./fonts/Satoshi-500.woff2", weight: "500" },
        { path: "./fonts/Satoshi-700.woff2", weight: "700" },
        { path: "./fonts/Satoshi-900.woff2", weight: "900" },
    ],
    variable: "--font-satoshi",
    display: "swap",
});

/**
 * Pages show catalogs bundled with the deployment, so they only change on a deploy (the data refresh
 * redeploys when a catalog changes, and every Monday) or when a moderator hides a review or publishes
 * a syllabus (those revalidate the course's page). Re-rendering once a week covers the rest: the
 * current term rolling over, and a university read from Supabase because it has no catalog file.
 * Each re-render is paid for, and crawlers visit tens of thousands of pages, so this isn't daily.
 */
export const revalidate = 604800;

const description =
    "Search courses at Canadian universities, see open seats and who's teaching, and plan a timetable that doesn't clash.";

export const metadata: Metadata = {
    metadataBase: new URL(SITE_URL),
    title: { default: `${SITE_NAME} - Course search and timetable planning`, template: `%s | ${SITE_NAME}` },
    description,
    applicationName: SITE_NAME,
    referrer: "origin-when-cross-origin",
    openGraph: { type: "website", locale: "en_CA", siteName: SITE_NAME },
    // The SVG follows the browser's light or dark theme; the .ico is for browsers without SVG icons.
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
        ],
        apple: "/apple-touch-icon.png",
    },
    robots: {
        index: true,
        follow: true,
        googleBot: {
            index: true,
            follow: true,
            "max-video-preview": -1,
            "max-image-preview": "large",
            "max-snippet": -1,
        },
    },
    verification: { google: process.env.GOOGLE_VERIFICATION },
    category: "technology",
    manifest: "/manifest.json",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en-CA" className={satoshi.variable} suppressHydrationWarning>
            <body>
                <Providers>{children}</Providers>
                <Analytics />
            </body>
        </html>
    );
}
