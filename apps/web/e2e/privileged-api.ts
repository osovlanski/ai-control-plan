/** Node fetch keeps setup credentials outside Playwright's recorded API requests.
 * Browser interactions remain traced; the bearer never enters the browser.
 */
export function privilegedApi(origin: string, secret: string) {
  async function call(path: string, method: string, data?: unknown) {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: () => response.status, json: () => response.json() };
  }
  return {
    get: (path: string) => call(path, "GET"),
    post: (path: string, options: { data: unknown }) => call(path, "POST", options.data),
  };
}
