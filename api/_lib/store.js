// The shop's own Vercel Blob store. Design and toolpath files must live there:
// the quote form keeps only links into it, and the server only downloads,
// serves or deletes files in it, so an order can't point it at a file in
// someone else's store. The store id is the fourth part of
// BLOB_READ_WRITE_TOKEN (vercel_blob_rw_<storeId>_<secret>), read the same way
// @vercel/blob reads it, and the store's public files are served from
// https://<storeId>.public.blob.vercel-storage.com/. With no token (local runs)
// any Vercel Blob store is accepted, as before.
export function inShopStore(url) {
  const id = ((process.env.BLOB_READ_WRITE_TOKEN || '').trim().split('_')[3] || '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(id)) return true;
  return String(url || '').startsWith(`https://${id}.public.blob.vercel-storage.com/`);
}
