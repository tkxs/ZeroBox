import type { ComponentType, SVGProps } from "react";

import McpLogoSource from "~icons/gravity-ui/logo-mcp";
import AlertCircleSource from "~icons/lucide/circle-alert";
import AlertTriangleSource from "~icons/lucide/triangle-alert";
import ClaudeSource from "~icons/logos/claude-icon";
import DefaultFileSource from "~icons/vscode-icons/default-file";
import FileTypeApacheSource from "~icons/vscode-icons/file-type-apache";
import FileTypeAudioSource from "~icons/vscode-icons/file-type-audio";
import FileTypeBinarySource from "~icons/vscode-icons/file-type-binary";
import FileTypeBunSource from "~icons/vscode-icons/file-type-bun";
import FileTypeCSource from "~icons/vscode-icons/file-type-c";
import FileTypeCargoSource from "~icons/vscode-icons/file-type-cargo";
import FileTypeCertSource from "~icons/vscode-icons/file-type-cert";
import FileTypeCmakeSource from "~icons/vscode-icons/file-type-cmake";
import FileTypeConfigSource from "~icons/vscode-icons/file-type-config";
import FileTypeCppSource from "~icons/vscode-icons/file-type-cpp";
import FileTypeCsharpSource from "~icons/vscode-icons/file-type-csharp";
import FileTypeCssSource from "~icons/vscode-icons/file-type-css";
import FileTypeDartSource from "~icons/vscode-icons/file-type-dartlang";
import FileTypeDbSource from "~icons/vscode-icons/file-type-db";
import FileTypeDockerSource from "~icons/vscode-icons/file-type-docker";
import FileTypeDotenvSource from "~icons/vscode-icons/file-type-dotenv";
import FileTypeEslintSource from "~icons/vscode-icons/file-type-eslint";
import FileTypeExcelSource from "~icons/vscode-icons/file-type-excel";
import FileTypeFontSource from "~icons/vscode-icons/file-type-font";
import FileTypeGeminiSource from "~icons/vscode-icons/file-type-gemini";
import FileTypeGitSource from "~icons/vscode-icons/file-type-git";
import FileTypeGoSource from "~icons/vscode-icons/file-type-go";
import FileTypeGoWorkSource from "~icons/vscode-icons/file-type-go-work";
import FileTypeGradleSource from "~icons/vscode-icons/file-type-gradle";
import FileTypeGraphqlSource from "~icons/vscode-icons/file-type-graphql";
import FileTypeHtmlSource from "~icons/vscode-icons/file-type-html";
import FileTypeImageSource from "~icons/vscode-icons/file-type-image";
import FileTypeIniSource from "~icons/vscode-icons/file-type-ini";
import FileTypeJavaSource from "~icons/vscode-icons/file-type-java";
import FileTypeJsSource from "~icons/vscode-icons/file-type-js";
import FileTypeJsConfigSource from "~icons/vscode-icons/file-type-jsconfig";
import FileTypeJsonSource from "~icons/vscode-icons/file-type-json";
import FileTypeKeySource from "~icons/vscode-icons/file-type-key";
import FileTypeKotlinSource from "~icons/vscode-icons/file-type-kotlin";
import FileTypeLicenseSource from "~icons/vscode-icons/file-type-license";
import FileTypeLogSource from "~icons/vscode-icons/file-type-log";
import FileTypeMarkdownSource from "~icons/vscode-icons/file-type-markdown";
import FileTypeMavenSource from "~icons/vscode-icons/file-type-maven";
import FileTypeNginxSource from "~icons/vscode-icons/file-type-nginx";
import FileTypeNodeSource from "~icons/vscode-icons/file-type-node";
import FileTypeNpmSource from "~icons/vscode-icons/file-type-npm";
import FileTypePackageSource from "~icons/vscode-icons/file-type-package";
import FileTypePdfSource from "~icons/vscode-icons/file-type-pdf2";
import FileTypePhpSource from "~icons/vscode-icons/file-type-php";
import FileTypePnpmSource from "~icons/vscode-icons/file-type-pnpm";
import FileTypePowerpointSource from "~icons/vscode-icons/file-type-powerpoint";
import FileTypePowershellSource from "~icons/vscode-icons/file-type-powershell";
import FileTypePrettierSource from "~icons/vscode-icons/file-type-prettier";
import FileTypePrismaSource from "~icons/vscode-icons/file-type-prisma";
import FileTypePythonSource from "~icons/vscode-icons/file-type-python";
import FileTypeReactJsSource from "~icons/vscode-icons/file-type-reactjs";
import FileTypeReactTsSource from "~icons/vscode-icons/file-type-reactts";
import FileTypeRubySource from "~icons/vscode-icons/file-type-ruby";
import FileTypeRustSource from "~icons/vscode-icons/file-type-rust";
import FileTypeScssSource from "~icons/vscode-icons/file-type-scss";
import FileTypeShellSource from "~icons/vscode-icons/file-type-shell";
import FileTypeSqlSource from "~icons/vscode-icons/file-type-sql";
import FileTypeSqliteSource from "~icons/vscode-icons/file-type-sqlite";
import FileTypeSvelteSource from "~icons/vscode-icons/file-type-svelte";
import FileTypeSwiftSource from "~icons/vscode-icons/file-type-swift";
import FileTypeSystemdSource from "~icons/vscode-icons/file-type-systemd";
import FileTypeTerraformSource from "~icons/vscode-icons/file-type-terraform";
import FileTypeTextSource from "~icons/vscode-icons/file-type-text";
import FileTypeTomlSource from "~icons/vscode-icons/file-type-toml";
import FileTypeTsConfigSource from "~icons/vscode-icons/file-type-tsconfig";
import FileTypeTsSource from "~icons/vscode-icons/file-type-typescript";
import FileTypeTsDefSource from "~icons/vscode-icons/file-type-typescriptdef";
import FileTypeVideoSource from "~icons/vscode-icons/file-type-video";
import FileTypeViteSource from "~icons/vscode-icons/file-type-vite";
import FileTypeVitestSource from "~icons/vscode-icons/file-type-vitest";
import FileTypeVueSource from "~icons/vscode-icons/file-type-vue";
import FileTypeWebpackSource from "~icons/vscode-icons/file-type-webpack";
import FileTypeWordSource from "~icons/vscode-icons/file-type-word";
import FileTypeXmlSource from "~icons/vscode-icons/file-type-xml";
import FileTypeYamlSource from "~icons/vscode-icons/file-type-yaml";
import FileTypeYarnSource from "~icons/vscode-icons/file-type-yarn";
import FileTypeZipSource from "~icons/vscode-icons/file-type-zip";
import ArrowLeftSource from "~icons/lucide/arrow-left";
import ArrowRightSource from "~icons/lucide/arrow-right";
import BanSource from "~icons/lucide/ban";
import BookOpenSource from "~icons/lucide/book-open";
import BotSource from "~icons/lucide/bot";
import BrainSource from "~icons/lucide/brain";
import BrushCleaningSource from "~icons/lucide/brush-cleaning";
import CheckSource from "~icons/lucide/check";
import CheckCircle2Source from "~icons/lucide/circle-check";
import ChevronDownSource from "~icons/lucide/chevron-down";
import ChevronRightSource from "~icons/lucide/chevron-right";
import ChevronUpSource from "~icons/lucide/chevron-up";
import CircleSource from "~icons/lucide/circle";
import Clock3Source from "~icons/lucide/clock-3";
import CloudSource from "~icons/lucide/cloud";
import ClipboardPasteSource from "~icons/lucide/clipboard-paste";
import CopySource from "~icons/lucide/copy";
import CpuSource from "~icons/lucide/cpu";
import DownloadSource from "~icons/lucide/download";
import Edit3Source from "~icons/lucide/pen-line";
import ExternalLinkSource from "~icons/lucide/external-link";
import EyeSource from "~icons/lucide/eye";
import EyeOffSource from "~icons/lucide/eye-off";
import FileSource from "~icons/lucide/file";
import FilePenLineSource from "~icons/lucide/file-pen-line";
import FileTextSource from "~icons/lucide/file-text";
import FolderSource from "~icons/lucide/folder";
import FolderOpenSource from "~icons/lucide/folder-open";
import FolderTreeSource from "~icons/lucide/folder-tree";
import GitBranchSource from "~icons/lucide/git-branch";
import GitCommitHorizontalSource from "~icons/lucide/git-commit-horizontal";
import GlobeSource from "~icons/lucide/globe";
import Globe2Source from "~icons/lucide/earth";
import GripVerticalSource from "~icons/lucide/grip-vertical";
import HardDriveSource from "~icons/lucide/hard-drive";
import HistorySource from "~icons/lucide/history";
import HomeSource from "~icons/lucide/house";
import ImageIconSource from "~icons/lucide/image";
import ImageOffSource from "~icons/lucide/image-off";
import KeySource from "~icons/lucide/key";
import LayoutGridSource from "~icons/lucide/layout-grid";
import Link2Source from "~icons/lucide/link-2";
import LightbulbSource from "~icons/lucide/lightbulb";
import ListSource from "~icons/lucide/list";
import Loader2Source from "~icons/lucide/loader-circle";
import LockSource from "~icons/lucide/lock";
import LogOutSource from "~icons/lucide/log-out";
import MessageSquareSource from "~icons/lucide/message-square";
import MessageSquareTextSource from "~icons/lucide/message-square-text";
import MonitorSmartphoneSource from "~icons/lucide/monitor-smartphone";
import MoonSource from "~icons/lucide/moon";
import MoreHorizontalSource from "~icons/lucide/ellipsis";
import OpenAISource from "~icons/logos/openai-icon";
import PanelLeftSource from "~icons/lucide/panel-left";
import PanelLeftCloseSource from "~icons/lucide/panel-left-close";
import PanelRightCloseSource from "~icons/lucide/panel-right-close";
import PanelRightOpenSource from "~icons/lucide/panel-right-open";
import PaperclipSource from "~icons/lucide/paperclip";
import PencilSource from "~icons/lucide/pencil";
import PinSource from "~icons/lucide/pin";
import PinOffSource from "~icons/lucide/pin-off";
import PlaySource from "~icons/lucide/play";
import PlugSource from "~icons/lucide/plug";
import PlusSource from "~icons/lucide/plus";
import RadioSource from "~icons/lucide/radio";
import Redo2Source from "~icons/lucide/redo-2";
import RefreshCwSource from "~icons/lucide/refresh-cw";
import ReplaceSource from "~icons/lucide/replace";
import SaveSource from "~icons/lucide/save";
import ScrollTextSource from "~icons/lucide/scroll-text";
import ScissorsSource from "~icons/lucide/scissors";
import SearchSource from "~icons/lucide/search";
import SendSource from "~icons/lucide/send";
import ServerSource from "~icons/lucide/server";
import SettingsSource from "~icons/lucide/settings";
import Settings2Source from "~icons/lucide/settings-2";
import Share2Source from "~icons/lucide/share-2";
import ShieldSource from "~icons/lucide/shield";
import SparklesSource from "~icons/lucide/sparkles";
import SquareSource from "~icons/lucide/square";
import SquarePenSource from "~icons/lucide/square-pen";
import SunSource from "~icons/lucide/sun";
import TagSource from "~icons/lucide/tag";
import TargetSource from "~icons/lucide/crosshair";
import TerminalSource from "~icons/lucide/terminal";
import TimerSource from "~icons/lucide/timer";
import TextSelectSource from "~icons/lucide/text-select";
import Trash2Source from "~icons/lucide/trash-2";
import Undo2Source from "~icons/lucide/undo-2";
import UploadSource from "~icons/lucide/upload";
import UserSource from "~icons/lucide/user";
import WifiSource from "~icons/lucide/wifi";
import WifiOffSource from "~icons/lucide/wifi-off";
import WrenchSource from "~icons/lucide/wrench";
import XSource from "~icons/lucide/x";
import XCircleSource from "~icons/lucide/circle-x";
import ZapSource from "~icons/lucide/zap";
import fileIconSvgSource from "~icons/lucide/file?raw";
import folderIconSvgSource from "~icons/lucide/folder?raw";

type IconSource = ComponentType<SVGProps<SVGSVGElement> & { title?: string }>;

type IconProps = SVGProps<SVGSVGElement> & {
  absoluteStrokeWidth?: boolean;
  size?: number | string;
  title?: string;
};

export type IconComponent = ComponentType<IconProps>;

function createIcon(Source: IconSource): IconComponent {
  return function Icon({
    absoluteStrokeWidth: _absoluteStrokeWidth,
    height,
    size,
    width,
    ...props
  }) {
    const nextProps: IconProps = { ...props };
    if (size !== undefined) {
      nextProps.width = width ?? size;
      nextProps.height = height ?? size;
    } else {
      if (width !== undefined) nextProps.width = width;
      if (height !== undefined) nextProps.height = height;
    }
    return <Source {...nextProps} />;
  };
}

const skillIconOuterPath = `M8102 20439 c-298 -35 -568 -170 -777 -390 -175 -183 -288 -406 -337
-667 -10 -54 -13 -1300 -13 -6347 0 -6030 1 -6283 18 -6365 74 -347 266 -634
550 -822 144 -95 269 -147 459 -191 92 -21 104 -21 1808 -26 l1715 -6 3690
-692 c2030 -381 3733 -698 3785 -704 123 -15 276 -5 411 25 480 109 863 496
963 973 58 275 2269 12123 2278 12207 14 129 0 295 -36 437 -105 413 -439 766
-844 893 -46 14 -928 184 -1960 376 -1032 193 -1883 354 -1891 358 -7 4 -28
49 -46 100 -127 355 -420 649 -773 776 -39 14 -116 36 -170 48 l-97 23 -4330
1 c-2381 1 -4363 -2 -4403 -7z m8810 -500 c298 -102 510 -345 557 -640 15 -88
15 -12428 1 -12517 -16 -95 -67 -226 -121 -306 -92 -138 -236 -256 -378 -311
-156 -59 188 -55 -4538 -53 l-4328 3 -73 23 c-295 91 -499 310 -569 608 -17
76 -18 289 -18 6299 l0 6220 22 86 c49 194 143 339 295 456 91 69 225 130 339
152 25 5 1953 8 4389 7 l4345 -1 77 -26z m2838 -1269 c971 -181 1794 -337
1830 -345 151 -37 328 -150 426 -273 62 -78 139 -240 159 -335 38 -176 115
256 -1119 -6332 -619 -3311 -1138 -6060 -1152 -6110 -62 -220 -207 -392 -419
-495 -207 -100 -314 -104 -730 -27 -159 30 -1273 238 -2475 463 l-2184 409
926 3 927 2 1473 -276 c810 -152 1507 -278 1548 -281 258 -17 513 150 615 404
28 68 2223 11780 2232 11903 18 269 -170 541 -431 624 -45 15 -824 165 -1741
336 -913 170 -1666 312 -1672 315 -10 3 -13 48 -13 175 0 157 1 170 18 170 10
0 812 -148 1782 -330z m-112 -575 c908 -170 1658 -315 1690 -327 42 -16 74
-38 123 -87 73 -73 105 -140 115 -240 5 -47 -165 -970 -1091 -5916 -603 -3223
-1100 -5879 -1106 -5903 -26 -116 -102 -213 -212 -267 -130 -64 -83 -70 -1187
138 l-974 184 84 27 c189 63 352 165 501 315 195 195 309 413 354 675 13 79
15 733 15 5903 l0 5815 28 -6 c15 -3 762 -143 1660 -311z`;

const skillIconInnerPath = `M8340 19620 c-138 -18 -292 -99 -385 -202 -54 -60 -104 -148 -137
-238 l-23 -65 -3 -6035 c-2 -5476 -1 -6042 13 -6114 49 -242 221 -424 465
-493 62 -17 225 -18 4180 -18 3369 0 4127 2 4180 13 181 37 358 175 438 342
22 47 45 109 51 138 16 75 16 12109 0 12184 -15 71 -79 202 -128 261 -84 100
-199 176 -328 214 -55 17 -281 18 -4163 19 -2258 1 -4130 -2 -4160 -6z m8231
-240 c122 -23 228 -105 283 -220 l31 -65 0 -6055 0 -6055 -28 -60 c-56 -119
-171 -205 -304 -225 -47 -7 -1349 -10 -4133 -8 -3755 3 -4069 4 -4113 20 -114
39 -204 125 -249 235 l-23 58 -3 6005 c-2 4516 0 6019 9 6060 32 155 156 279
311 309 64 13 8152 13 8219 1z`;

const skillIconStarPath = `M11967 15673 l-495 -858 -1021 -3 c-562 -1 -1021 -4 -1021 -6 0 -3
983 -1708 1005 -1742 13 -20 -26 -90 -496 -904 -280 -485 -509 -884 -509 -886
0 -2 460 -5 1021 -6 l1022 -3 491 -852 c270 -469 495 -851 500 -850 4 2 229
386 500 855 l491 852 1021 2 1022 3 -510 883 -510 883 510 882 509 882 -1018
3 -1019 2 -23 38 c-13 20 -237 406 -497 857 -260 451 -474 821 -475 823 -1 1
-225 -383 -498 -855z m732 -501 c112 -194 201 -355 199 -358 -3 -2 -201 -3
-441 -2 l-436 3 221 383 220 383 17 -28 c10 -15 109 -187 220 -381z m-1509
-839 c0 -17 -466 -811 -472 -805 -8 8 -468 803 -468 808 0 2 212 4 470 4 259
0 470 -3 470 -7z m2366 -645 l374 -647 -374 -648 -374 -648 -719 -2 -718 -2
-369 641 c-204 353 -370 649 -370 657 -1 9 166 305 369 658 l370 643 719 -3
718 -2 374 -647z m1097 604 c-16 -26 -122 -211 -237 -410 -115 -199 -213 -359
-217 -355 -5 6 -200 343 -466 806 -2 4 210 7 472 7 l475 0 -27 -48z m-3686
-2152 l229 -395 -470 -3 c-258 -1 -471 -1 -473 2 -3 3 407 721 454 795 12 19
17 21 24 10 4 -8 111 -192 236 -409z m3478 8 l233 -403 -233 -3 c-129 -1 -342
-1 -474 0 l-241 3 211 365 c116 201 222 384 236 408 13 24 27 41 30 38 3 -3
110 -187 238 -408z m-1548 -892 c-3 -8 -98 -173 -210 -368 -112 -194 -208
-361 -214 -371 -8 -15 -45 42 -213 335 -112 194 -212 368 -223 386 l-19 32
442 0 c377 0 441 -2 437 -14z`;

function SkillIconSource({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      {...props}
      version="1.0"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="620 505 1725 1725"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden={title ? undefined : true}
    >
      <title>{title ?? "Skill"}</title>
      <g transform="translate(0,2600) scale(0.1,-0.1)" fill="currentColor" stroke="none">
        <path d={skillIconOuterPath} />
        <path d={skillIconInnerPath} />
        <path d={skillIconStarPath} />
      </g>
    </svg>
  );
}

export const AlertCircle = createIcon(AlertCircleSource);
export const AlertTriangle = createIcon(AlertTriangleSource);
export const ClaudeIcon = createIcon(ClaudeSource);
export const FileTypeGeminiIcon = createIcon(FileTypeGeminiSource);
export const DefaultFile = createIcon(DefaultFileSource);
export const FileTypeApache = createIcon(FileTypeApacheSource);
export const FileTypeAudio = createIcon(FileTypeAudioSource);
export const FileTypeBinary = createIcon(FileTypeBinarySource);
export const FileTypeBun = createIcon(FileTypeBunSource);
export const FileTypeC = createIcon(FileTypeCSource);
export const FileTypeCargo = createIcon(FileTypeCargoSource);
export const FileTypeCert = createIcon(FileTypeCertSource);
export const FileTypeCmake = createIcon(FileTypeCmakeSource);
export const FileTypeConfig = createIcon(FileTypeConfigSource);
export const FileTypeCpp = createIcon(FileTypeCppSource);
export const FileTypeCsharp = createIcon(FileTypeCsharpSource);
export const FileTypeCss = createIcon(FileTypeCssSource);
export const FileTypeDart = createIcon(FileTypeDartSource);
export const FileTypeDb = createIcon(FileTypeDbSource);
export const FileTypeDocker = createIcon(FileTypeDockerSource);
export const FileTypeDotenv = createIcon(FileTypeDotenvSource);
export const FileTypeEslint = createIcon(FileTypeEslintSource);
export const FileTypeExcel = createIcon(FileTypeExcelSource);
export const FileTypeFont = createIcon(FileTypeFontSource);
export const FileTypeGit = createIcon(FileTypeGitSource);
export const FileTypeGo = createIcon(FileTypeGoSource);
export const FileTypeGoWork = createIcon(FileTypeGoWorkSource);
export const FileTypeGradle = createIcon(FileTypeGradleSource);
export const FileTypeGraphql = createIcon(FileTypeGraphqlSource);
export const FileTypeHtml = createIcon(FileTypeHtmlSource);
export const FileTypeImage = createIcon(FileTypeImageSource);
export const FileTypeIni = createIcon(FileTypeIniSource);
export const FileTypeJava = createIcon(FileTypeJavaSource);
export const FileTypeJs = createIcon(FileTypeJsSource);
export const FileTypeJsConfig = createIcon(FileTypeJsConfigSource);
export const FileTypeJson = createIcon(FileTypeJsonSource);
export const FileTypeKey = createIcon(FileTypeKeySource);
export const FileTypeKotlin = createIcon(FileTypeKotlinSource);
export const FileTypeLicense = createIcon(FileTypeLicenseSource);
export const FileTypeLog = createIcon(FileTypeLogSource);
export const FileTypeMarkdown = createIcon(FileTypeMarkdownSource);
export const FileTypeMaven = createIcon(FileTypeMavenSource);
export const FileTypeNginx = createIcon(FileTypeNginxSource);
export const FileTypeNode = createIcon(FileTypeNodeSource);
export const FileTypeNpm = createIcon(FileTypeNpmSource);
export const FileTypePackage = createIcon(FileTypePackageSource);
export const FileTypePdf = createIcon(FileTypePdfSource);
export const FileTypePhp = createIcon(FileTypePhpSource);
export const FileTypePnpm = createIcon(FileTypePnpmSource);
export const FileTypePowerpoint = createIcon(FileTypePowerpointSource);
export const FileTypePowershell = createIcon(FileTypePowershellSource);
export const FileTypePrettier = createIcon(FileTypePrettierSource);
export const FileTypePrisma = createIcon(FileTypePrismaSource);
export const FileTypePython = createIcon(FileTypePythonSource);
export const FileTypeReactJs = createIcon(FileTypeReactJsSource);
export const FileTypeReactTs = createIcon(FileTypeReactTsSource);
export const FileTypeRuby = createIcon(FileTypeRubySource);
export const FileTypeRust = createIcon(FileTypeRustSource);
export const FileTypeScss = createIcon(FileTypeScssSource);
export const FileTypeShell = createIcon(FileTypeShellSource);
export const FileTypeSql = createIcon(FileTypeSqlSource);
export const FileTypeSqlite = createIcon(FileTypeSqliteSource);
export const FileTypeSvelte = createIcon(FileTypeSvelteSource);
export const FileTypeSwift = createIcon(FileTypeSwiftSource);
export const FileTypeSystemd = createIcon(FileTypeSystemdSource);
export const FileTypeTerraform = createIcon(FileTypeTerraformSource);
export const FileTypeText = createIcon(FileTypeTextSource);
export const FileTypeToml = createIcon(FileTypeTomlSource);
export const FileTypeTs = createIcon(FileTypeTsSource);
export const FileTypeTsConfig = createIcon(FileTypeTsConfigSource);
export const FileTypeTsDef = createIcon(FileTypeTsDefSource);
export const FileTypeVideo = createIcon(FileTypeVideoSource);
export const FileTypeVite = createIcon(FileTypeViteSource);
export const FileTypeVitest = createIcon(FileTypeVitestSource);
export const FileTypeVue = createIcon(FileTypeVueSource);
export const FileTypeWebpack = createIcon(FileTypeWebpackSource);
export const FileTypeWord = createIcon(FileTypeWordSource);
export const FileTypeXml = createIcon(FileTypeXmlSource);
export const FileTypeYaml = createIcon(FileTypeYamlSource);
export const FileTypeYarn = createIcon(FileTypeYarnSource);
export const FileTypeZip = createIcon(FileTypeZipSource);
export const ArrowLeft = createIcon(ArrowLeftSource);
export const ArrowRight = createIcon(ArrowRightSource);
export const Ban = createIcon(BanSource);
export const BookOpen = createIcon(BookOpenSource);
export const Bot = createIcon(BotSource);
export const Brain = createIcon(BrainSource);
export const BrushCleaning = createIcon(BrushCleaningSource);
export const Check = createIcon(CheckSource);
export const CheckCircle2 = createIcon(CheckCircle2Source);
export const ChevronDown = createIcon(ChevronDownSource);
export const ChevronRight = createIcon(ChevronRightSource);
export const ChevronUp = createIcon(ChevronUpSource);
export const Circle = createIcon(CircleSource);
export const ClipboardPaste = createIcon(ClipboardPasteSource);
export const Clock3 = createIcon(Clock3Source);
export const Cloud = createIcon(CloudSource);
export const Copy = createIcon(CopySource);
export const Cpu = createIcon(CpuSource);
export const Download = createIcon(DownloadSource);
export const Edit3 = createIcon(Edit3Source);
export const ExternalLink = createIcon(ExternalLinkSource);
export const Eye = createIcon(EyeSource);
export const EyeOff = createIcon(EyeOffSource);
export const File = createIcon(FileSource);
export const FilePenLine = createIcon(FilePenLineSource);
export const FileText = createIcon(FileTextSource);
export const Folder = createIcon(FolderSource);
export const FolderOpen = createIcon(FolderOpenSource);
export const FolderTree = createIcon(FolderTreeSource);
export const GitBranch = createIcon(GitBranchSource);
export const GitCommitHorizontal = createIcon(GitCommitHorizontalSource);
export const Globe = createIcon(GlobeSource);
export const Globe2 = createIcon(Globe2Source);
export const GripVertical = createIcon(GripVerticalSource);
export const HardDrive = createIcon(HardDriveSource);
export const History = createIcon(HistorySource);
export const Home = createIcon(HomeSource);
export const ImageIcon = createIcon(ImageIconSource);
export const ImageOff = createIcon(ImageOffSource);
export const Key = createIcon(KeySource);
export const LayoutGrid = createIcon(LayoutGridSource);
export const Link2 = createIcon(Link2Source);
export const Lightbulb = createIcon(LightbulbSource);
export const List = createIcon(ListSource);
export const Loader2 = createIcon(Loader2Source);
export const Lock = createIcon(LockSource);
export const LogOut = createIcon(LogOutSource);
export const MessageSquare = createIcon(MessageSquareSource);
export const MessageSquareText = createIcon(MessageSquareTextSource);
export const McpLogo = createIcon(McpLogoSource);
export const MonitorSmartphone = createIcon(MonitorSmartphoneSource);
export const Moon = createIcon(MoonSource);
export const MoreHorizontal = createIcon(MoreHorizontalSource);
export const OpenaiChatgptIcon = createIcon(OpenAISource);
export const PanelLeft = createIcon(PanelLeftSource);
export const PanelLeftClose = createIcon(PanelLeftCloseSource);
export const PanelRightClose = createIcon(PanelRightCloseSource);
export const PanelRightOpen = createIcon(PanelRightOpenSource);
export const Paperclip = createIcon(PaperclipSource);
export const Pencil = createIcon(PencilSource);
export const Pin = createIcon(PinSource);
export const PinOff = createIcon(PinOffSource);
export const Play = createIcon(PlaySource);
export const Plug = createIcon(PlugSource);
export const Plus = createIcon(PlusSource);
export const Radio = createIcon(RadioSource);
export const Redo2 = createIcon(Redo2Source);
export const RefreshCw = createIcon(RefreshCwSource);
export const Replace = createIcon(ReplaceSource);
export const Save = createIcon(SaveSource);
export const ScrollText = createIcon(ScrollTextSource);
export const Scissors = createIcon(ScissorsSource);
export const Search = createIcon(SearchSource);
export const Send = createIcon(SendSource);
export const Server = createIcon(ServerSource);
export const Settings = createIcon(SettingsSource);
export const Settings2 = createIcon(Settings2Source);
export const Share2 = createIcon(Share2Source);
export const Shield = createIcon(ShieldSource);
export const SkillIcon = createIcon(SkillIconSource);
export const Sparkles = createIcon(SparklesSource);
export const Square = createIcon(SquareSource);
export const SquarePen = createIcon(SquarePenSource);
export const Sun = createIcon(SunSource);
export const Tag = createIcon(TagSource);
export const Target = createIcon(TargetSource);
export const Terminal = createIcon(TerminalSource);
export const Timer = createIcon(TimerSource);
export const TextSelect = createIcon(TextSelectSource);
export const Trash2 = createIcon(Trash2Source);
export const Undo2 = createIcon(Undo2Source);
export const Upload = createIcon(UploadSource);
export const User = createIcon(UserSource);
export const Wifi = createIcon(WifiSource);
export const WifiOff = createIcon(WifiOffSource);
export const Wrench = createIcon(WrenchSource);
export const X = createIcon(XSource);
export const XCircle = createIcon(XCircleSource);
export const Zap = createIcon(ZapSource);
const fileIconSvg = fileIconSvgSource as unknown as string;
const folderIconSvg = folderIconSvgSource as unknown as string;
export { fileIconSvg, folderIconSvg };
