package com.aika.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.aika.companion.data.ApiProtocol
import com.aika.companion.data.ApiProviderConfig
import com.aika.companion.data.ProviderCatalog
import com.aika.companion.data.local.ChatMessageEntity
import com.aika.companion.data.local.MemoryEntity

private enum class AppTab { CHAT, MEMORY, SETTINGS }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AikaApp(
    chatViewModel: ChatViewModel = viewModel(),
    memoryViewModel: MemoryViewModel = viewModel(),
    settingsViewModel: SettingsViewModel = viewModel(),
) {
    var currentTab by remember { mutableStateOf(AppTab.CHAT) }
    val providerState by settingsViewModel.providerState.collectAsState()
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Aika", fontWeight = FontWeight.SemiBold)
                        Text(
                            if (providerState.activeProviderReady) {
                                "${providerState.activeProvider?.name} · ${providerState.activeProvider?.model}"
                            } else {
                                "本地演示模式 · 请配置模型"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                },
            )
        },
        bottomBar = {
            BottomAppBar {
                NavigationBarItem(
                    selected = currentTab == AppTab.CHAT,
                    onClick = { currentTab = AppTab.CHAT },
                    icon = { Icon(Icons.Default.ChatBubble, contentDescription = null) },
                    label = { Text("聊天") },
                )
                NavigationBarItem(
                    selected = currentTab == AppTab.MEMORY,
                    onClick = { currentTab = AppTab.MEMORY },
                    icon = { Icon(Icons.Default.Psychology, contentDescription = null) },
                    label = { Text("记忆") },
                )
                NavigationBarItem(
                    selected = currentTab == AppTab.SETTINGS,
                    onClick = { currentTab = AppTab.SETTINGS },
                    icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                    label = { Text("设置") },
                )
            }
        },
    ) { padding ->
        when (currentTab) {
            AppTab.CHAT -> ChatScreen(chatViewModel, Modifier.padding(padding))
            AppTab.MEMORY -> MemoryScreen(memoryViewModel, Modifier.padding(padding))
            AppTab.SETTINGS -> SettingsScreen(settingsViewModel, Modifier.padding(padding))
        }
    }
}

@Composable
private fun ChatScreen(viewModel: ChatViewModel, modifier: Modifier = Modifier) {
    val messages by viewModel.messages.collectAsState()
    val isSending by viewModel.isSending.collectAsState()
    val errorMessage by viewModel.errorMessage.collectAsState()
    var draft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    Column(modifier.fillMaxSize()) {
        Live2DPlaceholder()
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (messages.isEmpty()) {
                item {
                    Text(
                        "跟我说点什么吧。可以直接说中文，也可以说日语。",
                        modifier = Modifier.padding(18.dp),
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }
            items(messages, key = { it.id }) { MessageBubble(it) }
            if (isSending) {
                item {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("Aika 正在输入…", color = MaterialTheme.colorScheme.secondary)
                    }
                }
            }
        }
        if (errorMessage != null) {
            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(errorMessage.orEmpty(), modifier = Modifier.weight(1f))
                    TextButton(onClick = viewModel::dismissError) { Text("知道了") }
                }
            }
        }
        MessageComposer(
            value = draft,
            onValueChange = { draft = it },
            enabled = !isSending,
            onSend = {
                viewModel.send(draft)
                draft = ""
            },
        )
    }
}

@Composable
private fun Live2DPlaceholder() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(170.dp)
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFFFFE3F0), Color(0xFFFFF8FC)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier
                    .size(84.dp)
                    .background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Favorite,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(40.dp),
                )
            }
            Spacer(Modifier.height(8.dp))
            Text("Live2D 模型将在这里显示", style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessageEntity) {
    val translations = remember { mutableStateMapOf<String, Boolean>() }
    val isUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(0.84f),
            shape = RoundedCornerShape(
                topStart = 18.dp,
                topEnd = 18.dp,
                bottomStart = if (isUser) 18.dp else 4.dp,
                bottomEnd = if (isUser) 4.dp else 18.dp,
            ),
            colors = CardDefaults.cardColors(
                containerColor = if (isUser) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    Color.White
                },
            ),
        ) {
            Column(Modifier.padding(14.dp)) {
                Text(message.originalText)
                if (!message.chineseTranslation.isNullOrBlank()) {
                    TextButton(
                        onClick = { translations[message.id] = translations[message.id] != true },
                        contentPadding = PaddingValues(0.dp),
                    ) {
                        Text(if (translations[message.id] == true) "收起中文" else "查看中文")
                    }
                    if (translations[message.id] == true) {
                        HorizontalDivider()
                        Text(
                            message.chineseTranslation,
                            modifier = Modifier.padding(top = 8.dp),
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageComposer(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { }) {
            Icon(Icons.Default.Mic, contentDescription = "开始语音")
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f),
            placeholder = { Text("中文或日语都可以…") },
            singleLine = true,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (value.isNotBlank()) onSend() }),
        )
        Spacer(Modifier.width(8.dp))
        FilledIconButton(onClick = onSend, enabled = enabled && value.isNotBlank()) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
        }
    }
}

@Composable
private fun MemoryScreen(viewModel: MemoryViewModel, modifier: Modifier = Modifier) {
    val memories by viewModel.memories.collectAsState()
    var draft by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().padding(16.dp)) {
        Text("她记得的事情", style = MaterialTheme.typography.headlineSmall)
        Text(
            "所有记忆只保存在这台手机上，你可以随时删除。",
            color = MaterialTheme.colorScheme.secondary,
        )
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("例如：我喜欢夜间散步") },
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    viewModel.add(draft)
                    draft = ""
                },
                enabled = draft.isNotBlank(),
            ) { Text("记住") }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(memories, key = { it.id }) { memory -> MemoryCard(memory, viewModel::delete) }
        }
    }
}

@Composable
private fun MemoryCard(memory: MemoryEntity, onDelete: (MemoryEntity) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(memory.category, style = MaterialTheme.typography.labelMedium)
                Text(memory.content)
            }
            IconButton(onClick = { onDelete(memory) }) {
                Icon(Icons.Default.Delete, contentDescription = "删除记忆")
            }
        }
    }
}

@Composable
private fun SettingsScreen(viewModel: SettingsViewModel, modifier: Modifier = Modifier) {
    val settings by viewModel.settings.collectAsState()
    val providerState by viewModel.providerState.collectAsState()
    val connectionTest by viewModel.connectionTest.collectAsState()
    var editingId by remember { mutableStateOf("") }
    var providerName by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("https://") }
    var model by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf(ApiProtocol.OPENAI_CHAT) }
    var confirmClear by remember { mutableStateOf(false) }
    var confirmDeleteId by remember { mutableStateOf<String?>(null) }

    val loadProvider: (ApiProviderConfig) -> Unit = { provider ->
        editingId = provider.id
        providerName = provider.name
        baseUrl = provider.baseUrl
        model = provider.model
        protocol = provider.protocol
        apiKey = ""
    }
    val resetEditor = {
        editingId = ""
        providerName = ""
        baseUrl = "https://"
        model = ""
        protocol = ApiProtocol.OPENAI_CHAT
        apiKey = ""
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Text("陪伴与模型设置", style = MaterialTheme.typography.headlineSmall)
            Text(
                "像 CC Switch 一样保存多套供应商配置，再一键切换。API Key 使用 Android Keystore 加密。",
                color = MaterialTheme.colorScheme.secondary,
            )
        }
        item {
            SettingSwitch(
                title = "允许主动联系",
                subtitle = "每天约 3–6 次，23:00–08:00 不打扰",
                checked = settings.proactiveEnabled,
                onCheckedChange = viewModel::setProactiveEnabled,
            )
        }
        item {
            Text("供应商", style = MaterialTheme.typography.titleLarge)
        }
        items(providerState.providers, key = { it.id }) { provider ->
            ProviderConfigCard(
                provider = provider,
                active = provider.id == providerState.activeProviderId,
                hasKey = provider.id in providerState.providersWithKeys,
                testing = connectionTest.testing && connectionTest.providerId == provider.id,
                onActivate = { viewModel.activateProvider(provider.id) },
                onTest = { viewModel.testProvider(provider.id) },
                onEdit = { loadProvider(provider) },
                onDelete = { confirmDeleteId = provider.id },
            )
        }
        connectionTest.message?.let { message ->
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = when (connectionTest.success) {
                            true -> MaterialTheme.colorScheme.primaryContainer
                            false -> MaterialTheme.colorScheme.errorContainer
                            null -> MaterialTheme.colorScheme.surfaceVariant
                        },
                    ),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (connectionTest.testing) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(10.dp))
                        }
                        Text(message, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
                        if (!connectionTest.testing) {
                            TextButton(onClick = viewModel::dismissConnectionTest) { Text("关闭") }
                        }
                    }
                }
            }
        }
        item {
            ProviderEditor(
                editing = editingId.isNotBlank(),
                name = providerName,
                onNameChange = { providerName = it },
                baseUrl = baseUrl,
                onBaseUrlChange = { baseUrl = it },
                model = model,
                onModelChange = { model = it },
                protocol = protocol,
                onProtocolChange = { protocol = it },
                apiKey = apiKey,
                onApiKeyChange = { apiKey = it },
                onPreset = { preset ->
                    editingId = ""
                    providerName = preset.name
                    baseUrl = preset.baseUrl
                    model = preset.model
                    protocol = preset.protocol
                    apiKey = ""
                },
                onSave = {
                    viewModel.saveProvider(
                        ApiProviderConfig(
                            id = editingId,
                            name = providerName,
                            protocol = protocol,
                            baseUrl = baseUrl,
                            model = model,
                        ),
                        apiKey,
                    )
                    resetEditor()
                },
                onCancel = resetEditor,
            )
        }
        item {
            OutlinedButton(onClick = { confirmClear = true }) {
                Text("清除所有 API Key")
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清除密钥？") },
            text = { Text("之后需要重新填写才能连接在线模型。") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.clearAllKeys()
                    confirmClear = false
                }) { Text("清除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text("取消") }
            },
        )
    }

    confirmDeleteId?.let { providerId ->
        AlertDialog(
            onDismissRequest = { confirmDeleteId = null },
            title = { Text("删除供应商？") },
            text = { Text("配置和对应的本地密钥都会被删除。") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.deleteProvider(providerId)
                    if (editingId == providerId) resetEditor()
                    confirmDeleteId = null
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteId = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ProviderConfigCard(
    provider: ApiProviderConfig,
    active: Boolean,
    hasKey: Boolean,
    testing: Boolean,
    onActivate: () -> Unit,
    onTest: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (active) MaterialTheme.colorScheme.primaryContainer else Color.White,
        ),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(provider.name, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${provider.protocol.displayName} · ${provider.model}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (active) Text("使用中", color = MaterialTheme.colorScheme.primary)
            }
            Text(
                provider.baseUrl,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.secondary,
                modifier = Modifier.padding(top = 4.dp),
            )
            Text(
                if (hasKey) "密钥已保存" else "未保存密钥，将使用本地演示回复",
                color = if (hasKey) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 6.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onEdit) { Text("编辑") }
                if (!active) TextButton(onClick = onActivate) { Text("使用") }
                if (hasKey) {
                    TextButton(onClick = onTest, enabled = !testing) {
                        Text(if (testing) "测试中" else "测试")
                    }
                }
                IconButton(onClick = onDelete) {
                    Icon(Icons.Default.Delete, contentDescription = "删除供应商")
                }
            }
        }
    }
}

@Composable
private fun ProviderEditor(
    editing: Boolean,
    name: String,
    onNameChange: (String) -> Unit,
    baseUrl: String,
    onBaseUrlChange: (String) -> Unit,
    model: String,
    onModelChange: (String) -> Unit,
    protocol: ApiProtocol,
    onProtocolChange: (ApiProtocol) -> Unit,
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    onPreset: (com.aika.companion.data.ProviderPreset) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (editing) "编辑供应商" else "添加供应商", style = MaterialTheme.typography.titleMedium)
            Text("快速模板", style = MaterialTheme.typography.labelMedium)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                ProviderCatalog.presets.forEach { preset ->
                    FilterChip(
                        selected = false,
                        onClick = { onPreset(preset) },
                        label = { Text(preset.name) },
                        modifier = Modifier.padding(end = 8.dp),
                    )
                }
            }
            Text("接口协议", style = MaterialTheme.typography.labelMedium)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                ApiProtocol.entries.forEach { item ->
                    FilterChip(
                        selected = protocol == item,
                        onClick = { onProtocolChange(item) },
                        label = { Text(item.displayName) },
                        modifier = Modifier.padding(end = 8.dp),
                    )
                }
            }
            OutlinedTextField(
                value = name,
                onValueChange = onNameChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("名称") },
                singleLine = true,
            )
            OutlinedTextField(
                value = baseUrl,
                onValueChange = onBaseUrlChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Base URL") },
                singleLine = true,
            )
            OutlinedTextField(
                value = model,
                onValueChange = onModelChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("模型名称") },
                singleLine = true,
            )
            OutlinedTextField(
                value = apiKey,
                onValueChange = onApiKeyChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("API Key") },
                placeholder = { Text(if (editing) "留空则保留原密钥" else "粘贴密钥") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (editing) TextButton(onClick = onCancel) { Text("取消") }
                Button(
                    onClick = onSave,
                    enabled = name.isNotBlank() && baseUrl.isNotBlank() && model.isNotBlank(),
                ) { Text(if (editing) "保存修改" else "添加") }
            }
        }
    }
}

@Composable
private fun SettingSwitch(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
