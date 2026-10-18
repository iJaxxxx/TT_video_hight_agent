import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { Button, Card } from '../components/ui';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useColors } from '../lib/theme';

export default function SettingsScreen() {
  const c = useColors();
  const { serverUrl, update } = useSettings();
  const [draft, setDraft] = useState(serverUrl);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    setResult(null);
    const base = draft.trim().replace(/\/+$/, '');
    try {
      const h = await api.health(base);
      setResult({ ok: true, text: `连接成功。大模型复核：${h.llm_enabled ? '已开启' : '未配置 API Key'}` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={[styles.label, { color: c.fg }]}>服务器地址</Text>
        <TextInput
          id="server-url"
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.5:8000"
          placeholderTextColor={c.muted}
          style={[styles.input, { color: c.fg, borderColor: c.line, backgroundColor: c.bg }]}
        />
        <Text style={[styles.help, { color: c.muted }]}>
          填运行 server 的电脑的局域网 IP 和端口 8000。手机和电脑要连同一个 Wi-Fi。
        </Text>
        {result && <Text style={{ color: result.ok ? c.t1 : c.danger, fontSize: 13 }}>{result.text}</Text>}
        <Button kind="secondary" title="测试连接" onPress={test} loading={testing} />
        <Button
          title="保存"
          onPress={() => {
            update({ serverUrl: draft });
            router.back();
          }}
        />
      </Card>

      <Card>
        <Text style={[styles.label, { color: c.fg }]}>大模型 API Key</Text>
        <Text style={[styles.help, { color: c.muted }]}>
          Key 只配置在服务器的 server/.env 里（LLM_API_KEY、LLM_BASE_URL、LLM_MODEL），App 里不保存任何密钥。没配置时，候选分由你在 App 里手动确认。
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 16 },
  label: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  help: { fontSize: 13, lineHeight: 19 },
});
