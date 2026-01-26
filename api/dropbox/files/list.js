const { json, getToken, getPayload, callJson } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  const token = getToken(req);
  if (!token) return json(res, 401, { error: "Missing x-dropbox-access-token" });
  const payload = getPayload(req);
  const path = payload.path;
  if (typeof path !== "string") return json(res, 400, { error: "Expected { path }" });

  try {
    const data = await callJson({
      token,
      path: "files/list_folder",
      payload: { path, recursive: false, include_deleted: false, include_non_downloadable_files: false }
    });
    return json(res, 200, { entries: data.entries || [] });
  } catch (err) {
    return json(res, 400, { error: err.message || "Dropbox error" });
  }
};

