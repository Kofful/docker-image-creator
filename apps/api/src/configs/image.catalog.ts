// Shared by the existing compiler and the next direct-Compose validator.
export const CATALOG = {
  node: { image: "node:22.23.4-bookworm-slim", port: 8000 },
  python: { image: "python:3.13.18-slim-bookworm", port: 8000 },
  mysql: { image: "mysql:8.4.11", port: 3306 },
  mongodb: { image: "mongo:8.0.17", port: 27017 },
} as const;
