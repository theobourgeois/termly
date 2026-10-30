import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/constants";
import { notFound } from "next/navigation";
import { accentCss } from "@/lib/accent";
import { AppShell } from "@/components/layout/app-shell";
import { UniversityProviders } from "@/components/providers";
import { getCourseIndex, getCurrentTerm, getTerms } from "@/lib/data";
import { getUniversity } from "@/lib/university";

type Props = { children: React.ReactNode; params: Promise<{ university: string }> };

/**
 * No university's pages are built ahead: they render on their first visit and are cached from then
 * on. Building them ahead made every deploy depend on the database, and when Supabase is throttled
 * the build's catalog reads time out and the deploy fails (Oct 22 to 29). An id that isn't a
 * university is a 404 (below).
 */
export function generateStaticParams() {
    return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const university = getUniversity((await params).university);
    if (!university) return {};
    // Each page sets its own title and canonical address; this covers the ones that don't (sign-in pages).
    return { title: { default: `${university.name} course search`, template: `%s | ${SITE_NAME}` } };
}

export default async function UniversityLayout({ children, params }: Props) {
    const { university } = await params;
    const info = getUniversity(university);
    if (!info) notFound();
    const [courseIndex, terms, currentTerm] = await Promise.all([
        getCourseIndex(university),
        getTerms(university),
        getCurrentTerm(university),
    ]);

    return (
        <>
            {/* Not in a wrapper's style, so menus and dialogs rendered outside the page get the accent too. */}
            <style dangerouslySetInnerHTML={{ __html: accentCss(info.accent) }} />
            <UniversityProviders
                university={university}
                courseIndex={courseIndex}
                terms={terms}
                currentTerm={currentTerm}
            >
                <AppShell>{children}</AppShell>
            </UniversityProviders>
        </>
    );
}
