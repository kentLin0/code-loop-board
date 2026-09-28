param(
    [Parameter(Mandatory = $true)]
    [int]$Port
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexTaskboard
{
    [Flags]
    public enum ActivateOptions
    {
        None = 0
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager
    {
    }

    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);
    }

    public static class PackagedAppLauncher
    {
        public static uint Launch(string appUserModelId, string arguments)
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            var result = manager.ActivateApplication(
                appUserModelId,
                arguments,
                ActivateOptions.None,
                out processId);
            Marshal.ThrowExceptionForHR(result);
            return processId;
        }
    }
}
"@

$arguments = "--remote-debugging-port=$Port --remote-allow-origins=http://127.0.0.1:$Port"
$processId = [CodexTaskboard.PackagedAppLauncher]::Launch(
    "OpenAI.Codex_2p2nqsd0c76g0!App",
    $arguments
)

Write-Output $processId
