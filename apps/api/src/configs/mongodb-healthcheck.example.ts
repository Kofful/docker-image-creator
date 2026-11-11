// Reference data for the model only; never injected into saved/runtime Compose.
export const MONGODB_HEALTHCHECK_EXAMPLE = {
  image: "mongo:8.0.17",
  healthcheckTest: [
    "CMD",
    "mongosh",
    "--quiet",
    "--norc",
    "--host",
    "127.0.0.1",
    "--port",
    "27017",
    "--eval",
    [
      "try {",
      "  const admin = db.getSiblingDB('admin');",
      "  const result = admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);",
      "  if (result.ok !== 1) quit(1);",
      "  quit(admin.runCommand({ ping: 1 }).ok === 1 ? 0 : 1);",
      "} catch { quit(1); }",
    ].join("\n"),
  ],
};
