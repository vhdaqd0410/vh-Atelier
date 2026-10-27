param(
    [string]$Ini,
    [string]$Out,
    [string]$Diag,
    [switch]$TestOnly
)

$ErrorActionPreference = 'Stop'

$sp = ''
$title = 'Select output folder'
if ($Ini -and (Test-Path $Ini)) {
    try {
        $raw = [System.IO.File]::ReadAllText($Ini, [System.Text.Encoding]::UTF8)
        $j = $raw | ConvertFrom-Json
        if ($j.path) { $sp = [string]$j.path }
        if ($j.title) { $title = [string]$j.title }
    } catch {}
}

$src = @'
using System;
using System.Runtime.InteropServices;

public static class FdPicker
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    class FileOpenDialogRCW { }

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int SetOptions(uint fos);
        [PreserveSig] int GetOptions(out uint pfos);
        [PreserveSig] int SetDefaultFolder(IntPtr psi);
        [PreserveSig] int SetFolder(IntPtr psi);
        [PreserveSig] int GetFolder(out IntPtr ppsi);
        [PreserveSig] int GetCurrentSelection(out IntPtr ppsi);
        [PreserveSig] int SetFileName(string pszName);
        [PreserveSig] int GetFileName(out IntPtr pszName);
        [PreserveSig] int SetTitle(string pszTitle);
        [PreserveSig] int SetOkButtonLabel(string pszText);
        [PreserveSig] int SetFileNameLabel(string pszLabel);
        [PreserveSig] int GetResult(out IntPtr ppsi);
        [PreserveSig] int AddPlace(IntPtr psi, uint fdap);
        [PreserveSig] int SetDefaultExtension(string pszDefaultExtension);
        [PreserveSig] int Close(int hr);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr pFilter);
        [PreserveSig] int GetResults(out IntPtr ppenum);
        [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IntPtr ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IntPtr psi, uint hint, out int piOrder);
    }

    public static string Test(string initialPath)
    {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        try
        {
            uint opts;
            int g1 = dlg.GetOptions(out opts);
            int s1 = dlg.SetOptions(opts | 0x20 | 0x40 | 0x800);
            if (!string.IsNullOrEmpty(initialPath))
            {
                Guid riid = typeof(IShellItem).GUID;
                IntPtr psi;
                int hr = SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref riid, out psi);
                if (hr != 0) return "SHCreate failed hr=" + hr;
                int s2 = dlg.SetFolder(psi);
                Marshal.Release(psi);
                return "OK getopts=" + g1 + " setopts=" + s1 + " shcreate=" + hr + " setfolder=" + s2;
            }
            return "OK getopts=" + g1 + " setopts=" + s1 + " (no path)";
        }
        finally { Marshal.ReleaseComObject(dlg); }
    }

    public static string Pick(string initialPath, string title)
    {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        try
        {
            uint opts;
            dlg.GetOptions(out opts);
            dlg.SetOptions(opts | 0x20 | 0x40 | 0x800);
            if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
            if (!string.IsNullOrEmpty(initialPath))
            {
                Guid riid = typeof(IShellItem).GUID;
                IntPtr psi;
                if (SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref riid, out psi) == 0)
                {
                    dlg.SetFolder(psi);
                    Marshal.Release(psi);
                }
            }
            int hr = dlg.Show(IntPtr.Zero);
            if (hr != 0) return null;
            IntPtr psiResult;
            dlg.GetResult(out psiResult);
            var si = (IShellItem)Marshal.GetObjectForIUnknown(psiResult);
            IntPtr namePtr;
            si.GetDisplayName(0x80058000, out namePtr);
            string path = Marshal.PtrToStringUni(namePtr);
            Marshal.FreeCoTaskMem(namePtr);
            Marshal.Release(psiResult);
            return path;
        }
        finally { Marshal.ReleaseComObject(dlg); }
    }
}
'@

Add-Type -TypeDefinition $src -ErrorAction Stop

if ($TestOnly) {
    $t = [FdPicker]::Test($sp)
    if ($Diag) { [System.IO.File]::WriteAllText($Diag, "TEST=" + $t, [System.Text.Encoding]::UTF8) }
    return
}

if ($Diag) {
    [System.IO.File]::WriteAllText($Diag, "initial=[" + $sp + "] exists=" + (Test-Path $sp), [System.Text.Encoding]::UTF8)
}

$result = [FdPicker]::Pick($sp, $title)
if ($result) {
    [System.IO.File]::WriteAllText($Out, $result, [System.Text.Encoding]::UTF8)
}
