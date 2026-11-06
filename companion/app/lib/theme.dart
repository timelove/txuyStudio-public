import 'package:flutter/material.dart';

/// 奶油金(cream-gold)主题 —— 与桌面端 `src/styles/app.css` 的
/// `[data-theme="cream-gold"]` 同值。
///
/// **桌面端 CSS 是唯一真相源**:这里只搬运 Web/移动端用得到的 `--mx-*` 变量,
/// 改色时两边一起改(参照关系写在每行注释里)。
///
/// 口径:暖纸米白底 #F6F1E7 + 白卡 #FFFFFF + 金色强调 #D4A843
/// (浅底上的可读金用 #A1781C,金底上的字用 #3A2C08)。
abstract final class Mx {
  // ---- 底 / 面 --------------------------------------------------------
  static const bg = Color(0xFFF6F1E7); // --mx-bg        暖纸窗底
  static const surface = Color(0xFFFFFDF7); // --mx-surface   抬层面
  static const card = Color(0xFFFFFFFF); // --mx-card-bg   白卡
  static const cardInner = Color(0xFFF4EEE0); // --mx-card-inner 卡内凹槽
  static const surface2 = Color(0xFFF0E9DA); // --mx-surface-2
  static const editorBg = Color(0xFFFAF6EC); // --mx-editor-bg 输入区
  static const tabbar = Color(0xFFEFE8D8); // --mx-tabbar-bg 底栏

  // ---- 边框 -----------------------------------------------------------
  static const border = Color(0xFFE2D9C4); // --mx-border
  static const borderStrong = Color(0xFFCBBF9F); // --mx-border-strong
  static const borderSoft = Color(0x0F000000); // rgba(0,0,0,.06)

  // ---- 文字 -----------------------------------------------------------
  static const text = Color(0xFF333333); // --mx-text
  static const textBright = Color(0xFF1A1815); // --mx-text-bright
  static const muted = Color(0xFF6E675A); // --mx-muted
  static const dim = Color(0xFF8C8574); // --mx-text-dim
  static const faint = Color(0xFF9A9284); // --mx-faint

  // ---- 强调(金) -----------------------------------------------------
  static const accent = Color(0xFFD4A843); // --mx-accent
  static const accentBright = Color(0xFFA1781C); // --mx-accent-bright(浅底可读金)
  static const accentContrast = Color(0xFF3A2C08); // --mx-accent-contrast(金底字)
  static const accentSoft = Color(0x24D4A843); // rgba(212,168,67,.14)
  static const selectedBg = Color(0x29D4A843); // rgba(212,168,67,.16)
  static const selectedBorder = Color(0x80B48C28); // rgba(180,140,40,.5)
  static const hover = Color(0x0B000000); // rgba(0,0,0,.045)

  /// 桌面端 `--mx-brand-gradient: linear-gradient(135deg, #d4a843, #b8860b)`。
  static const brandGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, Color(0xFFB8860B)],
  );

  // ---- 语义色(浅底可读深档) -----------------------------------------
  static const violet = Color(0xFF8A5CF6); // --mx-violet(品牌紫,恒定)
  static const violetSoft = Color(0x128A5CF6); // rgba(138,92,246,.07)
  static const violetBorder = Color(0x4D8A5CF6); // rgba(138,92,246,.3)
  static const danger = Color(0xFFC25656); // --mx-danger
  static const dangerSoft = Color(0x1AC25656); // rgba(194,86,86,.10)
  static const dangerBorder = Color(0x6BC25656); // rgba(194,86,86,.42)
  static const success = Color(0xFF4F7D3A); // --mx-success
  static const successSoft = Color(0x1F4F7D3A); // rgba(79,125,58,.12)
  static const warning = Color(0xFFB3851A); // --mx-warning
  static const warningSoft = Color(0x1FB3851A); // rgba(179,133,26,.12)
  static const info = Color(0xFF3056C8); // --mx-info
  static const infoSoft = Color(0x1A3056C8); // rgba(48,86,200,.10)
  static const orangeSoft = Color(0x17BF7124); // rgba(191,113,36,.09)

  // ---- 圆角(桌面端 --mx-radius-*) -----------------------------------
  static const radiusSm = 4.0;
  static const radiusMd = 8.0;
  static const radiusLg = 10.0;
}

/// 全局 ThemeData。材质组件一律压掉 M3 默认的紫色 tint,统一走奶油金。
ThemeData buildCompanionTheme() {
  const scheme = ColorScheme(
    brightness: Brightness.light,
    primary: Mx.accent,
    onPrimary: Mx.accentContrast,
    primaryContainer: Mx.accentSoft,
    onPrimaryContainer: Mx.accentBright,
    secondary: Mx.violet,
    onSecondary: Color(0xFFFFFFFF),
    secondaryContainer: Mx.violetSoft,
    onSecondaryContainer: Mx.violet,
    tertiary: Mx.info,
    onTertiary: Color(0xFFFFFFFF),
    tertiaryContainer: Mx.infoSoft,
    onTertiaryContainer: Mx.info,
    error: Mx.danger,
    onError: Color(0xFFFFFFFF),
    errorContainer: Mx.dangerSoft,
    onErrorContainer: Mx.danger,
    surface: Mx.surface,
    onSurface: Mx.text,
    onSurfaceVariant: Mx.muted,
    surfaceContainerLowest: Mx.card,
    surfaceContainerLow: Mx.surface,
    surfaceContainer: Mx.editorBg,
    surfaceContainerHigh: Mx.surface2,
    surfaceContainerHighest: Mx.cardInner,
    outline: Mx.borderStrong,
    outlineVariant: Mx.border,
    inverseSurface: Mx.textBright,
    onInverseSurface: Mx.surface,
    inversePrimary: Mx.accentSoft,
  );

  // M3 默认会把控件染成 scheme 派生色;这里逐项压掉,只留奶油金口径。
  const noTint = Colors.transparent;

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: scheme,
    scaffoldBackgroundColor: Mx.bg,
    canvasColor: Mx.bg,
    dividerColor: Mx.border,
    splashFactory: InkSparkle.splashFactory,
    iconTheme: const IconThemeData(color: Mx.muted, size: 20),
    appBarTheme: const AppBarTheme(
      backgroundColor: Mx.bg,
      foregroundColor: Mx.textBright,
      surfaceTintColor: noTint,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w600,
        color: Mx.textBright,
        letterSpacing: 0.2,
      ),
      iconTheme: IconThemeData(color: Mx.muted, size: 20),
      actionsIconTheme: IconThemeData(color: Mx.muted, size: 20),
      // 与桌面端顶栏一致:底下一根 1px 米色分界线。
      shape: Border(bottom: BorderSide(color: Mx.border)),
    ),
    cardTheme: CardThemeData(
      color: Mx.card,
      surfaceTintColor: noTint,
      elevation: 0,
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Mx.radiusLg),
        side: const BorderSide(color: Mx.border),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Mx.tabbar,
      surfaceTintColor: noTint,
      indicatorColor: Mx.selectedBg,
      elevation: 0,
      height: 62,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final on = states.contains(WidgetState.selected);
        return TextStyle(
          fontSize: 11,
          fontWeight: on ? FontWeight.w600 : FontWeight.w500,
          color: on ? Mx.accentBright : Mx.muted,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final on = states.contains(WidgetState.selected);
        return IconThemeData(size: 21, color: on ? Mx.accentBright : Mx.muted);
      }),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Mx.accent,
        foregroundColor: Mx.accentContrast,
        disabledBackgroundColor: Mx.cardInner,
        disabledForegroundColor: Mx.faint,
        elevation: 0,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Mx.radiusMd)),
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: Mx.accentBright,
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Mx.accentBright,
        side: const BorderSide(color: Mx.borderStrong),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Mx.radiusMd)),
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
      ),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? Mx.accentSoft : Mx.card,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? Mx.accentBright : Mx.muted,
        ),
        side: const WidgetStatePropertyAll(BorderSide(color: Mx.border)),
        elevation: const WidgetStatePropertyAll(0),
        textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Mx.editorBg,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      hintStyle: const TextStyle(fontSize: 12, color: Mx.faint),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        borderSide: const BorderSide(color: Mx.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        borderSide: const BorderSide(color: Mx.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        borderSide: const BorderSide(color: Mx.accent, width: 1.4),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        borderSide: const BorderSide(color: Mx.dangerBorder),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        borderSide: const BorderSide(color: Mx.danger),
      ),
      errorStyle: const TextStyle(fontSize: 11, color: Mx.danger),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Mx.card,
      surfaceTintColor: noTint,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Mx.border),
      ),
      titleTextStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Mx.textBright),
      contentTextStyle: const TextStyle(fontSize: 13, color: Mx.muted, height: 1.5),
    ),
    listTileTheme: const ListTileThemeData(iconColor: Mx.muted, textColor: Mx.text),
    dividerTheme: const DividerThemeData(color: Mx.border, thickness: 1, space: 1),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: Mx.accent,
      linearTrackColor: Mx.cardInner,
      circularTrackColor: Mx.cardInner,
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: Mx.textBright,
      contentTextStyle: TextStyle(fontSize: 12, color: Mx.surface),
      behavior: SnackBarBehavior.floating,
      elevation: 0,
    ),
    tooltipTheme: const TooltipThemeData(
      decoration: BoxDecoration(color: Mx.textBright, borderRadius: BorderRadius.all(Radius.circular(6))),
      textStyle: TextStyle(fontSize: 11, color: Mx.surface),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: const WidgetStatePropertyAll(Mx.borderStrong),
      radius: const Radius.circular(999),
      thickness: const WidgetStatePropertyAll(6),
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: Mx.accentBright,
      selectionColor: Mx.selectedBg,
      selectionHandleColor: Mx.accent,
    ),
  );
}
