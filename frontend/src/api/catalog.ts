import { getJson, invalidIds } from './http.ts'
import { isCategory, isCategoryDetail, isGenericProduct, isProduct, isProductDetail, page, results } from './schema.ts'
import type {
  ApiResult, Category, CategoryDetail, CategoryParams, GenericProduct, GenericProductParams, Page,
  Product, ProductDetail, ProductParams, RequestOptions, Results,
} from './types.ts'

export function getCategories(params: CategoryParams = {}, options: RequestOptions = {}): Promise<ApiResult<Results<Category>>> {
  return getJson('categories/', params, results(isCategory), options)
}
export async function getCategory(id: number, options: RequestOptions = {}): Promise<ApiResult<CategoryDetail>> {
  return invalidIds({ id }, options.signal) ?? getJson(`categories/${id}/`, {}, isCategoryDetail, options)
}
export async function getGenericProducts(params: GenericProductParams = {}, options: RequestOptions = {}): Promise<ApiResult<Page<GenericProduct>>> {
  return invalidIds({ category: params.category }, options.signal)
    ?? getJson('generic-products/', params, page(isGenericProduct), options)
}
export async function getGenericProduct(id: number, options: RequestOptions = {}): Promise<ApiResult<GenericProduct>> {
  return invalidIds({ id }, options.signal) ?? getJson(`generic-products/${id}/`, {}, isGenericProduct, options)
}
export async function getProducts(params: ProductParams = {}, options: RequestOptions = {}): Promise<ApiResult<Page<Product>>> {
  return invalidIds({ category: params.category, generic: params.generic, brand: params.brand }, options.signal)
    ?? getJson('products/', params, page(isProduct), options)
}
export async function getProduct(id: number, options: RequestOptions = {}): Promise<ApiResult<ProductDetail>> {
  return invalidIds({ id }, options.signal) ?? getJson(`products/${id}/`, {}, isProductDetail, options)
}
