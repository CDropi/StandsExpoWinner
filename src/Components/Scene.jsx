import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'

import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { ShaderPass } from 'three/examples/jsm/Addons.js'

// Nombre del modelo GLTF a cargar (colócalo en /public/Stands/)
const MODEL_PATH = `${import.meta.env.BASE_URL}Stands/Mapa_Stands.gltf`

// Multiplicador de distancia de la cámara respecto al tamaño del modelo.
// Más alto = cámara más lejos (ve más del modelo). Más bajo = más cerca (zoom).
const CAMERA_DISTANCE_MULTIPLIER = 0.7

// Desplaza el punto donde "mira" la cámara (el centro del encuadre), como fracción
// de la distancia de cámara actual (así el efecto se ve igual sin importar el zoom).
// Esto SÍ mueve el modelo dentro del cuadro (a diferencia del ángulo de cámara,
// que solo rota alrededor del punto de enfoque).
// Positivo en X = el punto de enfoque se mueve a la derecha -> el modelo se ve más a la izquierda.
// Positivo en Y = el punto de enfoque sube -> el modelo se ve más abajo en pantalla.
// Positivo en Z = el punto de enfoque se aleja hacia adelante -> el modelo se ve más atrás.
const TARGET_OFFSET_X = 0
const TARGET_OFFSET_Y = 0
const TARGET_OFFSET_Z = 0

const Scene = () => {
    const mountRef = useRef(null)

    useEffect(() => {
        const currentMount = mountRef.current

        //Scene
        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(
            50,
            currentMount.clientWidth / currentMount.clientHeight,
            0.1,
            5000
        )
        scene.add(camera)

        //Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.toneMapping = THREE.ReinhardToneMapping
        renderer.toneMappingExposure = 1.5
        renderer.shadowMap.enabled = true
        renderer.setPixelRatio(window.devicePixelRatio)
        renderer.setSize(currentMount.clientWidth, currentMount.clientHeight)
        currentMount.appendChild(renderer.domElement)

        const fxaaPass = new ShaderPass(FXAAShader)
        const pixelRatio = renderer.getPixelRatio()
        fxaaPass.material.uniforms['resolution'].value.x = 1 / (window.innerWidth * pixelRatio)
        fxaaPass.material.uniforms['resolution'].value.y = 1 / (window.innerHeight * pixelRatio)

        //Controls
        const controls = new OrbitControls(camera, renderer.domElement)
        controls.minPolarAngle = 0.4
        controls.maxPolarAngle = 1.26
        controls.enableDamping = true
        controls.dampingFactor = 0.08

        //Post-processing (solo antialiasing, sin bloom)
        const renderScene = new RenderPass(scene, camera)

        const composer = new EffectComposer(renderer)
        composer.addPass(renderScene)
        composer.addPass(fxaaPass)

        //Skybox
        const base = import.meta.env.BASE_URL
        const enviromentMap = new THREE.CubeTextureLoader()
        const envMap = enviromentMap.load([
            `${base}EnvMap/px.png`,
            `${base}EnvMap/nx.png`,
            `${base}EnvMap/py.png`,
            `${base}EnvMap/ny.png`,
            `${base}EnvMap/pz.png`,
            `${base}EnvMap/nz.png`,
        ])
        scene.environment = envMap

        //Directional light principal (proyecta sombras, se ajusta al modelo una vez cargado)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 4)
        directionalLight.shadow.mapSize = new THREE.Vector2(2048, 2048)
        directionalLight.shadow.bias = -0.0002
        directionalLight.castShadow = true
        scene.add(directionalLight)
        scene.add(directionalLight.target)

        // Luces direccionales de relleno (sin sombra, para no duplicar el costo de render):
        // una desde el lado opuesto a la principal, otra más frontal/baja, para llenar
        // las zonas que la luz principal deja oscuras.
        const fillLight1 = new THREE.DirectionalLight(0xffffff, 4)
        scene.add(fillLight1)
        scene.add(fillLight1.target)

        const fillLight2 = new THREE.DirectionalLight(0xffffff, 1.8)
        scene.add(fillLight2)
        scene.add(fillLight2.target)

        // Luz ambiental/de relleno: ilumina toda la escena de forma pareja,
        // sin depender de ángulo, para que las zonas en sombra no queden muy oscuras.
        // HemisphereLight da un tono de "cielo" arriba y "piso" abajo, más natural que AmbientLight plano.
        //const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5)
        //scene.add(hemiLight)

        // Calcula un bounding box "de encuadre" ignorando mallas gigantes tipo piso/fondo,
        // que si no distorsionan por completo el cálculo de cámara (ej. un plano de asfalto
        // que cubre todo el terreno). Se detectan por tamaño comparado a la mediana de mallas.
        function computeFramingBox(root) {
            const meshBoxes = []
            root.traverse((obj) => {
                if (!obj.isMesh) return
                const b = new THREE.Box3().setFromObject(obj)
                const s = new THREE.Vector3()
                b.getSize(s)
                meshBoxes.push({ box: b, diag: s.length() })
            })

            if (meshBoxes.length === 0) return new THREE.Box3().setFromObject(root)

            const sortedDiags = meshBoxes.map((m) => m.diag).sort((a, b) => a - b)
            const median = sortedDiags[Math.floor(sortedDiags.length / 2)] || 0

            const framingBox = new THREE.Box3()
            let included = 0
            meshBoxes.forEach(({ box: b, diag }) => {
                if (median > 0 && diag > median * 30) return // outlier real (ej. piso gigante), se ignora para el encuadre
                framingBox.union(b)
                included++
            })

            return included > 0 ? framingBox : new THREE.Box3().setFromObject(root)
        }

        // Ajusta camara + luz direccional al bounding box real del modelo
        function frameModel(object3D) {
            const box = computeFramingBox(object3D)
            const size = new THREE.Vector3()
            const center = new THREE.Vector3()
            box.getSize(size)
            box.getCenter(center)

            // Usamos la ESFERA envolvente (no el ancho/alto máximo de la caja) para calcular
            // la distancia de cámara. Una esfera se ve igual de centrada/redonda sin importar
            // desde qué ángulo diagonal la mires; una caja rectangular vista en diagonal
            // proyecta sus esquinas de forma asimétrica y por eso quedaba corrida hacia un lado.
            const framingSphere = new THREE.Sphere()
            box.getBoundingSphere(framingSphere)
            const radius = framingSphere.radius

            const maxDim = Math.max(size.x, size.y, size.z)
            const fov = camera.fov * (Math.PI / 180)
            const hFov = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect)
            const limitingFov = Math.min(fov, hFov) // el más restrictivo de los dos (vertical u horizontal)
            let distance = radius / Math.sin(limitingFov / 2)
            distance *= CAMERA_DISTANCE_MULTIPLIER

            // Aplica el desplazamiento manual del punto de enfoque, escalado por "distance"
            // (no por maxDim) para que el efecto visual sea el mismo sin importar
            // qué tan cerca/lejos esté la cámara (CAMERA_DISTANCE_MULTIPLIER).
            center.x += distance * TARGET_OFFSET_X
            center.y += distance * TARGET_OFFSET_Y
            center.z += distance * TARGET_OFFSET_Z

            // Bounding box COMPLETO (incluye el piso/fondo gigante) solo para
            // calcular el far plane, así nunca se recorta aunque acerquemos la cámara.
            const fullBox = new THREE.Box3().setFromObject(object3D)
            const fullSphere = new THREE.Sphere()
            fullBox.getBoundingSphere(fullSphere)

            // Dirección de vista: mismo ángulo diagonal de siempre, pero ahora aplicado
            // como vector unitario, no como fracción directa de "distance" por eje.
            const viewDir = new THREE.Vector3(-2, 2, 3).normalize()
            camera.position.copy(center).addScaledVector(viewDir, distance)

            camera.near = Math.max(distance / 200, 0.05)
            camera.updateProjectionMatrix()
            camera.lookAt(center)

            controls.target.copy(center)
            controls.minDistance = distance * 0.25
            controls.maxDistance = distance * 1.2
            controls.update()

            // far cubre el peor caso: cámara alejada al máximo permitido por OrbitControls,
            // mirando hacia el punto más lejano del bounding box completo (incluye el piso).
            const distCentersXZ = center.distanceTo(fullSphere.center)
            camera.far = (controls.maxDistance + distCentersXZ + fullSphere.radius) * 1.3
            camera.updateProjectionMatrix()

            directionalLight.position.set(
                center.x + size.x * 0.4,
                center.y + maxDim * 0.6,
                center.z + size.z * 0.35
            )
            directionalLight.target.position.copy(center)
            directionalLight.shadow.camera.left = -radius * 1.2
            directionalLight.shadow.camera.right = radius * 1.2
            directionalLight.shadow.camera.top = radius * 1.2
            directionalLight.shadow.camera.bottom = -radius * 1.2
            directionalLight.shadow.camera.far = radius * 6
            directionalLight.shadow.camera.updateProjectionMatrix()

            // Luz de relleno 1: lado opuesto a la principal (rellena las sombras que deja esa)
            fillLight1.position.set(
                center.x - size.x * 0.4,
                center.y + maxDim * 0.5,
                center.z - size.z * 0.35
            )
            fillLight1.target.position.copy(center)

            // Luz de relleno 2: más baja y frontal (ilumina caras verticales/laterales)
            fillLight2.position.set(
                center.x + size.x * 0.1,
                center.y + maxDim * 0.15,
                center.z + size.z * 0.6
            )
            fillLight2.target.position.copy(center)
        }

        //Loader
        const gltfLoader = new GLTFLoader()
        gltfLoader.load(
            MODEL_PATH,
            (gltf) => {
                gltf.scene.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true
                        child.receiveShadow = true
                    }
                })
                scene.add(gltf.scene)
                frameModel(gltf.scene)
            },
            () => {},
            (error) => {
                console.error('Error cargando el modelo GLTF:', error)
            }
        )

        //Events
        const handleResize = () => {
            const width = currentMount.clientWidth
            const height = currentMount.clientHeight
            camera.aspect = width / height
            camera.updateProjectionMatrix()
            renderer.setSize(width, height)
            renderer.setPixelRatio(window.devicePixelRatio)
            composer.setSize(width, height)

            const pr = renderer.getPixelRatio()
            fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pr)
            fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pr)
        }
        window.addEventListener('resize', handleResize)

        // Render loop
        let frameId
        const animate = () => {
            controls.update()
            composer.render()
            frameId = requestAnimationFrame(animate)
        }
        animate()

        // Clean up scene
        return () => {
            cancelAnimationFrame(frameId)
            window.removeEventListener('resize', handleResize)
            controls.dispose()
            renderer.dispose()
            currentMount.removeChild(renderer.domElement)
        }
    }, [])

    return (
        <div
            className="Scene"
            ref={mountRef}
            style={{ width: '100%', height: '100vh' }}
        ></div>
    )
}

export default Scene
