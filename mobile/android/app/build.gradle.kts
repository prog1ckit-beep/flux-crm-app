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
        versionCode = 2
        versionName = "1.0.1"
        buildConfigField("boolean", "HAS_FIREBASE", hasFirebase.toString())
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // внутреннее использование: debug-подпись, ставим APK руками
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
