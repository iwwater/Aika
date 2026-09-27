use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::Connection;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
pub struct SqlStatement {
    query: String,
    #[serde(default)]
    values: Vec<Value>,
}

async fn run_batch(
    connection: &mut SqliteConnection,
    statements: Vec<SqlStatement>,
) -> Result<(), sqlx::Error> {
    let mut transaction = connection.begin().await?;
    for statement in statements {
        let mut query = sqlx::query(&statement.query);
        for value in statement.values {
            query = if value.is_null() {
                query.bind(None::<Value>)
            } else if let Some(text) = value.as_str() {
                query.bind(text.to_owned())
            } else if let Some(number) = value.as_number() {
                query.bind(number.as_f64().unwrap_or_default())
            } else {
                query.bind(value)
            };
        }
        query.execute(&mut *transaction).await?;
    }
    transaction.commit().await
}

/// plugin-sql 的独立 execute 调用从连接池取连接，不能跨调用拼 BEGIN/COMMIT。
/// 知识索引的 staging/激活与 FTS 重建在这条固定数据库的连接上原子执行。
#[tauri::command]
pub async fn knowledge_sql_batch(
    app: AppHandle,
    statements: Vec<SqlStatement>,
) -> Result<(), String> {
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("aika.db");
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| error.to_string())?;
    run_batch(&mut connection, statements)
        .await
        .map_err(|error| error.to_string())
}
