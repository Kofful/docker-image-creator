/**
 * Prompt reference for mysql:8.4.11, exercised through real Compose in tests.
 * This is example data for the model, never injected into a saved revision.
 * Raw credentials stay in the environment; SQL encoding happens in-container.
 */
const bootstrap = [
  "set +x",
  "source /usr/local/bin/docker-entrypoint.sh",
  "sql_literal() {",
  '  local quote="\'"',
  '  local value=${1//"$quote"/"$quote$quote"}',
  '  printf "\'%s\'" "$value"',
  "}",
  "sql_identifier() {",
  "  local tick='`'",
  '  local value=${1//"$tick"/"$tick$tick"}',
  "  printf '`%s`' \"$value\"",
  "}",
  "docker_process_sql() {",
  '  local password="$MYSQL_ROOT_PASSWORD"',
  '  if [ "${1:-}" = --dont-use-mysql-root-password ]; then password=; shift; fi',
  '  MYSQL_PWD="$password" mysql --no-defaults --binary-mode --default-character-set=utf8mb4 --protocol=socket -uroot --socket="$SOCKET" "$@" 2>/dev/null || mysql_error "MySQL bootstrap SQL failed"',
  "}",
  "docker_temp_server_stop() {",
  '  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin --no-defaults --protocol=socket -uroot --socket="$SOCKET" shutdown 2>/dev/null || mysql_error "MySQL bootstrap shutdown failed"',
  "}",
  "docker_setup_db() {",
  '  if [ -z "${MYSQL_INITDB_SKIP_TZINFO:-}" ]; then',
  "    mysql_tzinfo_to_sql /usr/share/zoneinfo 2>/dev/null |",
  "      sed 's/Local time zone must be set--see zic manual page/FCTY/' |",
  "      docker_process_sql --dont-use-mysql-root-password --database=mysql",
  "  fi",
  "  local root_password user_password root_host app_user database grant_database",
  '  root_password=$(sql_literal "$MYSQL_ROOT_PASSWORD")',
  '  user_password=$(sql_literal "$MYSQL_PASSWORD")',
  '  root_host=$(sql_literal "$MYSQL_ROOT_HOST")',
  '  app_user=$(sql_literal "$MYSQL_USER")',
  '  database=$(sql_identifier "$MYSQL_DATABASE")',
  // MySQL GRANT treats underscores as wildcards even inside backtick identifiers.
  '  local underscore_escape="\\_"',
  '  grant_database=$(sql_identifier "${MYSQL_DATABASE//_/"$underscore_escape"}")',
  "  {",
  '    printf "%s\\n" "SET SESSION sql_mode = \'NO_BACKSLASH_ESCAPES\';" "SET @@SESSION.SQL_LOG_BIN=0;"',
  "    printf \"ALTER USER 'root'@'localhost' IDENTIFIED BY %s;\\n\" \"$root_password\"",
  "    printf \"GRANT ALL ON *.* TO 'root'@'localhost' WITH GRANT OPTION;\\n\"",
  '    if [ "$MYSQL_ROOT_HOST" != localhost ]; then',
  '      printf "CREATE USER \'root\'@%s IDENTIFIED BY %s;\\n" "$root_host" "$root_password"',
  '      printf "GRANT ALL ON *.* TO \'root\'@%s WITH GRANT OPTION;\\n" "$root_host"',
  "    fi",
  '    printf "%s\\n" "DROP DATABASE IF EXISTS test;"',
  '    printf "CREATE DATABASE IF NOT EXISTS %s;\\n" "$database"',
  '    printf "CREATE USER %s@\'%%\' IDENTIFIED BY %s;\\n" "$app_user" "$user_password"',
  '    printf "GRANT ALL ON %s.* TO %s@\'%%\';\\n" "$grant_database" "$app_user"',
  "  } | docker_process_sql --dont-use-mysql-root-password --database=mysql",
  "}",
  "_main mysqld",
].join("\n");

// Prepare image-owned directories as root, then install the function overrides
// as mysql. Otherwise the stock root-to-mysql re-exec would lose the overrides.
const prepare = [
  "set +x",
  "source /usr/local/bin/docker-entrypoint.sh",
  "mysql_check_config mysqld",
  "docker_setup_env mysqld",
  "docker_create_db_directories mysqld",
  'if [ "$(id -u)" = 0 ]; then exec gosu mysql bash -ce "$1"; fi',
  'exec bash -ce "$1"',
].join("\n");

/** Dollars are escaped for Compose, including both nested bash programs. */
export const MYSQL_BOOTSTRAP_EXAMPLE = {
  image: "mysql:8.4.11",
  command: ["bash", "-ce", prepare, "--", bootstrap].map((arg) =>
    arg.replaceAll("$", () => "$$"),
  ),
  healthcheckTest: [
    "CMD-SHELL",
    'MYSQL_PWD="$$MYSQL_PASSWORD" mysql --no-defaults --connect-timeout=3 --protocol=TCP -h 127.0.0.1 --user="$$MYSQL_USER" --database="$$MYSQL_DATABASE" --batch --skip-column-names -e "SELECT 1" >/dev/null 2>&1',
  ],
};
