import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// FCM включается только если рядом лежит google-services.json (из консоли Firebase). Без него push.register → none.
val hasFirebase = file("google-services.json").exists()
if (hasFirebase) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "md.fan.dvizhok"
    compileSdk = 35

    defaultConfig {
        applicationId = "md.fan.dvizhok"
        minSdk = 26
        targetSdk = 35
        versionCode = 6
        versionName = "1.0.5"
        buildConfigField("boolean", "HAS_FIREBASE", hasFirebase.toString())
    }
    // Постоянный ключ подписи (mobile/android/keystore.properties, вне git; копия в секретах Hub2) — обновления ставятся
    // поверх друг друга только при одном ключе. Без файла — debug-ключ (только для локальной отладки).
    val ksProps = Properties().apply { rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
    signingConfigs {
        create("release") {
            if (ksProps.getProperty("storeFile") != null) {
                storeFile = rootProject.file(ksProps.getProperty("storeFile"))
                storePassword = ksProps.getProperty("storePassword")
                keyAlias = ksProps.getProperty("keyAlias")
                keyPassword = ksProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksProps.getProperty("storeFile") != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets {
        getByName("main") {
            // Один источник fan-device.js на все платформы — папка web/ репозитория, без копий.
            assets.srcDirs("src/main/assets", "../../../web")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
