import { NextResponse, type NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"
import { OLD_HOSTS, SITE_URL } from "@/lib/constants"
import { DEFAULT_UNIVERSITY, getUniversity } from "@/lib/university"

/**
 * The landing page is at /, and every university's pages are under its id: /dal/explore, /msvu/CSCI2110.
 * Dal's pages used to be at the root of the site (on dalsearch.com), so those addresses redirect to
 * Dal's page for them: dalsearch.com/CSCI2110 and termly.ca/CSCI2110 both go to termly.ca/dal/CSCI2110.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const [, first = ""] = pathname.split("/")

  // API routes, files (/manifest.json, /robots.txt) and the landing page's social image aren't pages.
  const isPage = !["api", "opengraph-image"].includes(first) && !/\.[a-z0-9]+$/i.test(pathname)
  const isDalPage = isPage && !getUniversity(first)
  const dalPath = `/${DEFAULT_UNIVERSITY}${pathname === "/" ? "" : pathname}`

  if (OLD_HOSTS.includes(request.headers.get("host") ?? "")) {
    return NextResponse.redirect(new URL(`${isDalPage ? dalPath : pathname}${search}`, SITE_URL), 308)
  }
  if (!isDalPage || pathname === "/") return updateSession(request)

  const url = request.nextUrl.clone()
  url.pathname = dalPath
  return NextResponse.redirect(url, 308)
}

export const config = {
  matcher: [
    /*
     * Pages only; every request it runs on is billed, and crawlers make most of them. Not:
     * - _next/static, _next/image: the app's files and optimized images
     * - api/: API routes read the session themselves, and serve the same on the old hosts
     * - opengraph-image: social images (any page's)
     * - files: robots.txt, sitemap.xml, manifest.json, icons, images, fonts
     */
    "/((?!_next/static|_next/image|api/|(?:.*/)?opengraph-image$|.*\\.(?:ico|svg|png|jpg|jpeg|gif|webp|txt|xml|json|webmanifest|woff2?)$).*)",
  ],
}
