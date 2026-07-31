param(
    [string]$OutputPath = (Join-Path $PSScriptRoot "..\src\FamilyFinance.App\Assets\family-finance.ico")
)

$size = 64
$pixels = New-Object 'byte[]' ($size * $size * 4)

function Set-Pixel([int]$x, [int]$y, [byte]$r, [byte]$g, [byte]$b, [byte]$a = 255) {
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $size -or $y -ge $size) { return }
    $offset = (($size - 1 - $y) * $size + $x) * 4
    $pixels[$offset] = $b; $pixels[$offset + 1] = $g; $pixels[$offset + 2] = $r; $pixels[$offset + 3] = $a
}

for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
        $corner = 11
        $outside = (($x -lt $corner -and $y -lt $corner -and (($x - $corner) * ($x - $corner) + ($y - $corner) * ($y - $corner) -gt $corner * $corner)) -or
                    ($x -ge $size - $corner -and $y -lt $corner -and (($x - ($size - $corner - 1)) * ($x - ($size - $corner - 1)) + ($y - $corner) * ($y - $corner) -gt $corner * $corner)) -or
                    ($x -lt $corner -and $y -ge $size - $corner -and (($x - $corner) * ($x - $corner) + ($y - ($size - $corner - 1)) * ($y - ($size - $corner - 1)) -gt $corner * $corner)) -or
                    ($x -ge $size - $corner -and $y -ge $size - $corner -and (($x - ($size - $corner - 1)) * ($x - ($size - $corner - 1)) + ($y - ($size - $corner - 1)) * ($y - ($size - $corner - 1)) -gt $corner * $corner)))
        if (-not $outside) { Set-Pixel $x $y 19 33 48 }
    }
}

# White ledger F, plus three mint bars that stay readable at 16px.
for ($y = 16; $y -lt 48; $y++) { for ($x = 15; $x -lt 21; $x++) { Set-Pixel $x $y 245 250 255 } }
for ($y = 16; $y -lt 22; $y++) { for ($x = 20; $x -lt 37; $x++) { Set-Pixel $x $y 245 250 255 } }
for ($y = 29; $y -lt 35; $y++) { for ($x = 20; $x -lt 33; $x++) { Set-Pixel $x $y 245 250 255 } }
for ($y = 35; $y -lt 49; $y++) { for ($x = 42; $x -lt 47; $x++) { Set-Pixel $x $y 66 200 160 } }
for ($y = 27; $y -lt 49; $y++) { for ($x = 50; $x -lt 55; $x++) { Set-Pixel $x $y 185 244 122 } }

[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))) | Out-Null
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::Create)
$writer = New-Object IO.BinaryWriter($stream)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]64); $writer.Write([byte]64); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32](40 + $pixels.Length)); $writer.Write([UInt32]22)
$writer.Write([UInt32]40); $writer.Write([Int32]$size); $writer.Write([Int32]($size * 2)); $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]0); $writer.Write([UInt32]$pixels.Length); $writer.Write([Int32]0); $writer.Write([Int32]0); $writer.Write([UInt32]0); $writer.Write([UInt32]0)
$writer.Write($pixels); $writer.Close(); $stream.Close()
