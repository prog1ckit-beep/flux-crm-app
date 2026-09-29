package md.fan.dvizhok

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** Нативный экран настроек: адрес сервера (руками или QR), дополнительные адреса. */
class SettingsActivity : AppCompatActivity() {
    private lateinit var settings: Settings

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        settings = Settings(this)
        val url = findViewById<EditText>(R.id.serverUrl)
        val hosts = findViewById<EditText>(R.id.allowHosts)
        val msg = findViewById<TextView>(R.id.msg)
        url.setText(settings.serverUrl)
        hosts.setText(settings.allowHosts)

        findViewById<Button>(R.id.scanQr).setOnClickListener {
            val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            GmsBarcodeScanning.getClient(this, opts).startScan()
                .addOnSuccessListener { b -> val v = b.rawValue ?: ""; if (v.startsWith("http")) url.setText(v) else msg.text = "В QR не адрес: $v" }
                .addOnFailureListener { e -> msg.text = "Сканер: ${e.message}" }
        }
        findViewById<Button>(R.id.save).setOnClickListener {
            val v = url.text.toString().trim()
            if (Settings.origin(v) == null) { msg.text = "Нужен адрес вида https://…"; return@setOnClickListener }
            settings.serverUrl = v
            settings.allowHosts = hosts.text.toString()
            finish()
        }
    }
}
