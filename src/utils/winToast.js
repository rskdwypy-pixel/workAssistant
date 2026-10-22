// Windows 系统通知：PowerShell 调 Windows 通知中心。标题和内容从环境变量传入，不拼进脚本（防注入）；
// 借用 PowerShell 的应用 ID（未注册应用 ID 的程序发不出通知）
/**
 * 调 Windows PowerShell 5.1 时用的环境变量：去掉 PSModulePath。
 * 从 PowerShell 7 里拉起的进程会带着 7 的模块路径，5.1 继承后自带命令（Get-CimInstance 等）就加载不上。
 */
export function windowsPowerShellEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.PSModulePath;
  return env;
}

export const WIN_TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml(\'<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>\')',
  '$t = $xml.GetElementsByTagName(\'text\')',
  '$t.Item(0).AppendChild($xml.CreateTextNode($env:WA_NOTIFY_TITLE)) | Out-Null',
  '$t.Item(1).AppendChild($xml.CreateTextNode($env:WA_NOTIFY_MESSAGE)) | Out-Null',
  '$app = \'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe\'',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))'
].join('; ');
