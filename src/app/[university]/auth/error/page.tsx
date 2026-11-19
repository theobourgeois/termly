import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** Shows the error in the query, so it can't be cached (see the rooms page). */
export const dynamic = "force-dynamic"

export default async function Page({ searchParams }: { searchParams: Promise<{ error: string }> }) {
  const params = await searchParams

  return (
    <div className="flex justify-center py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Sorry, something went wrong.</CardTitle>
            </CardHeader>
            <CardContent>
              {params?.error ? (
                <p className="text-sm text-fg-muted">Code error: {params.error}</p>
              ) : (
                <p className="text-sm text-fg-muted">An unspecified error occurred.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
