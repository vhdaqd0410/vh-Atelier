class _FakeExt:
    def is_available(self):
        return False
def lazy_import_ffmpeg_ext():
    return _FakeExt()
