package com.aika.companion.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import dagger.hilt.android.qualifiers.ApplicationContext
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SecretStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val preferences = context.getSharedPreferences("aika_secrets", Context.MODE_PRIVATE)

    fun hasSecret(name: String): Boolean = preferences.contains("${name}_ciphertext")

    fun save(name: String, value: String) {
        if (value.isBlank()) {
            clear(name)
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        preferences.edit {
            putString("${name}_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            putString("${name}_ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        }
    }

    fun read(name: String): String? {
        val iv = preferences.getString("${name}_iv", null) ?: return null
        val ciphertext = preferences.getString("${name}_ciphertext", null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(
                cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)),
                StandardCharsets.UTF_8,
            )
        }.getOrNull()
    }

    fun clear(name: String) {
        preferences.edit {
            remove("${name}_iv")
            remove("${name}_ciphertext")
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    companion object {
        const val OPENAI_KEY = "openai"
        const val QWEN_KEY = "qwen"
        fun providerKeyName(providerId: String): String = when (providerId) {
            "openai" -> OPENAI_KEY
            "qwen" -> QWEN_KEY
            else -> "provider.$providerId"
        }
        private const val KEY_STORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "aika_local_api_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
