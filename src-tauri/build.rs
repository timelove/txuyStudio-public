fn main() {
    // updater.rs 的 option_env!("TXUY_UPDATE_ENDPOINT") 依赖本 env:声明后 BaseUrl
    // 变了会自动重编(否则增量编译拿着旧值,注入不生效)。
    println!("cargo:rerun-if-env-changed=TXUY_UPDATE_ENDPOINT");
    tauri_build::build()
}
