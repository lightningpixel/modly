import glob
import os
import platform

import torch
from setuptools import find_packages, setup
from torch.utils.cpp_extension import (
    CUDA_HOME,
    BuildExtension,
    CppExtension,
    CUDAExtension,
)

library_name = "texture_baker"

IS_WINDOWS = platform.system() == "Windows"
IS_MACOS = platform.system() == "Darwin"


def get_extensions():
    debug_mode = os.getenv("DEBUG", "0") == "1"
    use_cuda = os.getenv("USE_CUDA", "1" if torch.cuda.is_available() else "0") == "1"
    use_metal = (
        os.getenv("USE_METAL", "1" if torch.backends.mps.is_available() else "0") == "1"
    )
    use_native_arch = os.getenv("USE_NATIVE_ARCH", "1") == "1"
    if debug_mode:
        print("Compiling in debug mode")

    use_cuda = use_cuda and CUDA_HOME is not None
    extension = CUDAExtension if use_cuda else CppExtension

    is_hip_extension = True if ((os.environ.get('ROCM_HOME') is not None) and (torch.version.hip is not None)) else False

    extra_link_args = []

    if IS_WINDOWS:
        # MSVC flags
        cxx_flags = ["/O2" if not debug_mode else "/Od", "/openmp"]
        if debug_mode:
            cxx_flags += ["/Z7"]
            extra_link_args += ["/DEBUG"]
    elif IS_MACOS:
        # Prefer a conservative Apple Silicon toolchain over OpenMP-specific flags.
        cxx_flags = [
            "-O3" if not debug_mode else "-O0",
            "-fdiagnostics-color=always",
            "-mmacosx-version-min=11.0",
        ]
        if use_native_arch:
            cxx_flags.append("-mcpu=apple-m1")
        if debug_mode:
            cxx_flags += ["-g", "-UNDEBUG"]
            extra_link_args += ["-O0", "-g"]
    else:
        # GCC/Clang flags
        cxx_flags = [
            "-O3" if not debug_mode else "-O0",
            "-fdiagnostics-color=always",
            "-fopenmp",
        ]
        if use_native_arch:
            cxx_flags.append("-march=native")
        if debug_mode:
            cxx_flags += ["-g", "-UNDEBUG"]
            extra_link_args += ["-O0", "-g"]

    extra_compile_args = {
        "cxx": cxx_flags,
        "nvcc": ["-O3" if not debug_mode else "-O0"],
    }
    if debug_mode and not IS_WINDOWS:
        extra_compile_args["nvcc"].append("-UNDEBUG")
        extra_compile_args["nvcc"].append("-g")

    define_macros = []
    extensions = []
    libraries = []

    this_dir = os.path.dirname(os.path.curdir)
    sources = glob.glob(
        os.path.join(this_dir, library_name, "csrc", "**", "*.cpp"), recursive=True
    )

    if len(sources) == 0:
        print("No source files found for extension, skipping extension compilation")
        return None

    if use_cuda:
        define_macros += [
            ("THRUST_IGNORE_CUB_VERSION_CHECK", None),
        ]
        sources += glob.glob(
            os.path.join(this_dir, library_name, "csrc", "**", "*.cu"), recursive=True
        )

        if not is_hip_extension:
            libraries += ["cudart", "c10_cuda"]

    if use_metal:
        define_macros += [
            ("WITH_MPS", None),
        ]
        sources += glob.glob(
            os.path.join(this_dir, library_name, "csrc", "**", "*.mm"), recursive=True
        )
        if IS_MACOS:
            if "-arch" not in extra_link_args:
                extra_link_args += [
                    "-arch",
                    "arm64",
                    "-framework",
                    "Metal",
                    "-framework",
                    "Foundation",
                ]
            cxx_flags.extend(["-arch", "arm64"])

    extensions.append(
        extension(
            name=f"{library_name}._C",
            sources=sources,
            define_macros=define_macros,
            extra_compile_args=extra_compile_args,
            extra_link_args=extra_link_args,
            libraries=libraries
            + [
                "c10",
                "torch",
                "torch_cpu",
                "torch_python",
            ],
        )
    )

    for ext in extensions:
        ext.libraries = ["cudart_static" if x == "cudart" else x for x in ext.libraries]

    print(extensions)

    return extensions


setup(
    name=library_name,
    version="0.0.1",
    packages=find_packages(where="."),
    package_dir={"": "."},
    ext_modules=get_extensions(),
    install_requires=[],
    package_data={
        library_name: [os.path.join("csrc", "*.h"), os.path.join("csrc", "*.metal")],
    },
    description="Small texture baker which rasterizes barycentric coordinates to a tensor.",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/Stability-AI/texture_baker",
    cmdclass={"build_ext": BuildExtension},
)
